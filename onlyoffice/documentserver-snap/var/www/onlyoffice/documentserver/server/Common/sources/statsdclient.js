/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

var statsD = require('node-statsd');
var configStatsD = require('config').get('statsd');

var cfgStatsDUseMetrics = configStatsD.get('useMetrics');
var cfgStatsDHost = configStatsD.get('host');
var cfgStatsDPort = configStatsD.get('port');
var cfgStatsDPrefix = configStatsD.get('prefix');

var clientStatsD = null;
if(cfgStatsDUseMetrics) {
  clientStatsD = new statsD({host: cfgStatsDHost, port:cfgStatsDPort, prefix: cfgStatsDPrefix});
}

exports.getClient = function() {
  return clientStatsD;
};
