/*
 * Racing – webOS JS service (Node 12 on the TV).
 * Starts the LAN server (server.js) that phones join with the code shown on the TV.
 *
 *   luna://com.ekrani.racing.service/start {}  -> { returnValue, ip, port }
 *       call with subscribe:true: the open subscription keeps the service (and the server) alive
 *   luna://com.ekrani.racing.service/ping  {}  -> { returnValue }
 */
'use strict';

var pkgInfo = require('./package.json');
var Service = require('webos-service');
var server = require('./server');

var service = new Service(pkgInfo.name);
try { service.activityManager.idleTimeout = 120; } catch (e) { /* older webos-service */ }

var subs = {};

service.register('start', function (message) {
  server.start(8900, function (err, port) {
    if (err) return message.respond({ returnValue: false, errorText: String(err && err.message || err) });
    message.respond({ returnValue: true, ip: server.localIp(), port: port, subscribed: !!message.isSubscription });
    if (message.isSubscription) subs[message.uniqueToken] = message;
  });
}, function (message) {
  delete subs[message.uniqueToken];
});

service.register('ping', function (message) {
  message.respond({ returnValue: true, port: server.state.port });
});
