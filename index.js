/**
 * Copyright 2016 vmarchaud. All rights reserved.
 * Use of this source code is governed by a license that
 * can be found in the LICENSE file.
 */

const http = require('http');
const crypto = require('crypto');
const pmx = require('pmx');
const pm2 = require('pm2');
const util = require('util');
const async = require('async');
const vizion = require('vizion');
const ipaddr = require('ipaddr.js');

const {localeDateString, logCallback, reqToAppName, spawnAsExec} = require('./helpers');

/**
 * Constructor of our worker
 *
 * @param {object} opts The options
 * @returns {Worker} The instance of our worker
 * @constructor
 */
const Worker = function (opts) {
	if (!(this instanceof Worker)) {
		return new Worker(opts);
	}

	this.opts = opts;
	this.port = this.opts.port || 8888;
	this.apps = opts.apps;

	if (typeof (this.apps) !== 'object') {
		this.apps = JSON.parse(this.apps);
	}

	this.server = http.createServer(this._handleHttp.bind(this));
	return this;
};

/**
 * Init pmx module
 */
pmx.initModule({}, (err, conf) => {
	pm2.connect((err2) => {
		if (err || err2) {
			console.error('[%s] Error: %s', localeDateString(), JSON.stringify(err || err2));
			process.exit(1);
			return;
		}
		// init the worker only if we can connect to pm2
		new Worker(conf).start();
	});
});

/**
 * Main function for http server
 *
 * @param req The Request
 * @param res The Response
 * @private
 */
Worker.prototype._handleHttp = function (req, res) {
	const self = this;

	// send instant answer since its useless to respond to the webhook
	res.writeHead(200, {'Content-Type': 'text/plain'});
	res.write('OK');

	// do something only with post request
	if (req.method !== 'POST') {
		res.end();
		return;
	}

	// get source ip
	req.ip = req.headers['x-forwarded-for'] || (req.connection ? req.connection.remoteAddress : false) ||
		(req.socket ? req.socket.remoteAddress : false) || ((req.connection && req.connection.socket) ?
			req.connection.socket.remoteAddress : false) || '';
	if (req.ip.indexOf('::ffff:') !== -1) {
		req.ip = req.ip.replace('::ffff:', '');
	}

	// get the whole body before processing
	req.body = '';
	req.on('data', (data) => {
		req.body += data;
	}).on('end', () => {
		self.processRequest(req);
	});

	res.end();
};

const oldSpawns = {};

/**
 * Main function of the module
 *
 * @param req The Request of the call
 */
Worker.prototype.processRequest = function (req) {
	const targetName = reqToAppName(req);
	if (targetName.length === 0) return;

	if (!oldSpawns[targetName]) oldSpawns[targetName] = {};

	const targetApp = this.apps[targetName];
	if (!targetApp) return;

	const error = this.checkRequest(targetApp, req);
	if (error) {
		logCallback(() => {}, '[%s] App: %s\nError: %s', localeDateString(), targetName, JSON.stringify(error));
		return;
	}

	logCallback(() => {}, '[%s] Received valid hook for app %s', localeDateString(), targetName);

	const execOptions = {
		cwd: targetApp.cwd,
		env: process.env,
		shell: true,
	};
	const phases = {
		resolveCWD: function resolveCWD(cb) {
			// if cwd is provided, we expect that it isnt a pm2 app
			if (targetApp.cwd) {
				cb();
				return;
			}

			// try to get the cwd to execute it correctly
			pm2.describe(targetName, (err, apps) => {
				if (err || !apps || apps.length === 0) return cb(err || new Error('Application not found'));

				// execute the actual command in the cwd of the application
				targetApp.cwd = apps[0].pm_cwd ? apps[0].pm_cwd : apps[0].pm2_env.pm_cwd;
				return cb();
			});
		},

		pullTheApplication: function pullTheApplication(cb) {
			vizion.update({
				folder: targetApp.cwd,
			}, logCallback(cb, '[%s] Successfuly pulled application %s', localeDateString(), targetName));
		},

		preHook: function preHook(cb) {
			if (!targetApp.prehook) {
				cb();
				return;
			}

			const oldChild = oldSpawns[targetName].prehook;
			if (oldChild) logCallback(oldChild.kill, '[%s] Killed old prehook process as new request received %s', localeDateString(), targetName);

			const child = spawnAsExec(targetApp.prehook, execOptions,
				logCallback(cb, '[%s] Prehook command has been successfuly executed for app %s', localeDateString(), targetName),
				() => { oldSpawns[targetName].prehook = undefined });

			oldSpawns[targetName].prehook = child;
		},

		reloadApplication: function reloadApplication(cb) {
			if (targetApp.nopm2) {
				cb();
				return;
			}
			pm2.gracefulReload(targetName,
				logCallback(cb, '[%s] Successfuly reloaded application %s', localeDateString(), targetName));
		},

		postHook: function postHook(cb) {
			if (!targetApp.posthook) {
				cb();
				return;
			}
			// execute the actual command in the cwd of the application
			spawnAsExec(targetApp.posthook, execOptions,
				logCallback(cb, '[%s] Posthook command has been successfuly executed for app %s', localeDateString(), targetName));
		},
	};
	async.series(Object.keys(phases).map(k => phases[k]),
		(err) => {
			if (err) {
				logCallback(() => {}, '[%s] An error has occuring while processing app %s', localeDateString(), targetName);
				const log = util.format('[%s] App : %s\nError: %s', localeDateString(), targetName, JSON.stringify(err));
				logCallback(() => {}, log);
				console.error(log);
			}
		});
};

/**
 * Checks if a request is valid for an app.
 *
 * @param targetApp The app which the request has to be valid
 * @param req The request to analyze
 * @returns {string|true} True if success or the string of the error if not.
 */
// eslint-disable-next-line
Worker.prototype.checkRequest = function (targetApp, req) {
	const targetName = reqToAppName(req);

	switch (targetApp.service) {
		case 'gitlab': {
			if (!req.headers['x-gitlab-token']) {
				return util.format('[%s] Received invalid request for app %s (no headers found)', localeDateString(), targetName);
			}

			if (req.headers['x-gitlab-token'] !== targetApp.secret) {
				return util.format('[%s] Received invalid request for app %s (not matching secret)', localeDateString(), targetName);
			}
			break;
		}
		case 'jenkins': {
			// ip must match the secret
			if (req.ip.indexOf(targetApp.secret) < 0) {
				return util.format('[%s] Received request from %s for app %s but ip configured was %s', localeDateString(), req.ip, targetName, targetApp.secret);
			}

			const body = JSON.parse(req.body);
			if (body.build.status !== 'SUCCESS') {
				return util.format('[%s] Received valid hook but with failure build for app %s', localeDateString(), targetName);
			}
			if (targetApp.branch && body.build.scm.branch.indexOf(targetApp.branch) < 0) {
				return util.format('[%s] Received valid hook but with a branch %s than configured for app %s', localeDateString(), body.build.scm.branch, targetName);
			}
			break;
		}
		case 'droneci': {
			// Authorization header must match configured secret
			if (!req.headers.Authorization) {
				return util.format('[%s] Received invalid request for app %s (no headers found)', localeDateString(), targetName);
			}
			if (req.headers.Authorization !== targetApp.secret) {
				return util.format('[%s] Received request from %s for app %s but incorrect secret', localeDateString(), req.ip, targetName);
			}

			const data = JSON.parse(req.body);
			if (data.build.status !== 'SUCCESS') {
				return util.format('[%s] Received valid hook but with failure build for app %s', localeDateString(), targetName);
			}
			if (targetApp.branch && data.build.branch.indexOf(targetApp.branch) < 0) {
				return util.format('[%s] Received valid hook but with a branch %s than configured for app %s', localeDateString(), data.build.branch, targetName);
			}
			break;
		}
		case 'bitbucket': {
			const tmp = JSON.parse(req.body);
			const ip = targetApp.secret || '104.192.143.0/24';
			const configured = ipaddr.parseCIDR(ip);
			const source = ipaddr.parse(req.ip);

			if (!source.match(configured)) {
				return util.format('[%s] Received request from %s for app %s but ip configured was %s', localeDateString(), req.ip, targetName, ip);
			}
			if (!tmp.push) {
				return util.format("[%s] Received valid hook but without 'push' data for app %s", localeDateString(), targetName);
			}
			if (targetApp.branch && tmp.push.changes[0] &&
				tmp.push.changes[0].new.name.indexOf(targetApp.branch) < 0) {
				return util.format('[%s] Received valid hook but with a branch %s than configured for app %s', localeDateString(), tmp.push.changes[0].new.name, targetName);
			}
			break;
		}
		case 'github':
		default: {
			if (!req.headers['x-github-event'] || !req.headers['x-hub-signature']) {
				return util.format('[%s] Received invalid request for app %s (no headers found)', localeDateString(), targetName);
			}

			// compute hash of body with secret, github should send this to verify authenticity
			const temp = crypto.createHmac('sha1', targetApp.secret);
			temp.update(req.body, 'utf-8');
			const hash = temp.digest('hex');

			if ('sha1=' + hash !== req.headers['x-hub-signature']) {
				return util.format('[%s] Received invalid request for app %s', localeDateString(), targetName);
			}
			break;
		}
	}
	return false;
};

/**
 * Lets start our server
 */
Worker.prototype.start = function () {
	const self = this;
	this.server.listen(this.opts.port, () => {
		logCallback(() => {}, '[%s] Server is ready and listen on port %s', localeDateString(), self.port);
	});
};
