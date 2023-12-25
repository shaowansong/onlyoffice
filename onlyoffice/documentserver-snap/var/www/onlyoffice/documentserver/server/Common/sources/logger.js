/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

var config = require('config');
var util = require('util');

var log4js = require('log4js');
var dateToJSONWithTZ = function (d) {
  var timezoneOffsetInHours = -(d.getTimezoneOffset() / 60); //UTC minus local time
  var sign = timezoneOffsetInHours >= 0 ? '+' : '-';
  var leadingZero = (Math.abs(timezoneOffsetInHours) < 10) ? '0' : '';
  var correctedDate = new Date(d.getFullYear(), d.getMonth(), 
      d.getDate(), d.getHours(), d.getMinutes(), d.getSeconds(), 
      d.getMilliseconds());
  correctedDate.setHours(d.getHours() + timezoneOffsetInHours);
  var iso = correctedDate.toISOString().replace('Z', '');
  return iso + sign + leadingZero + Math.abs(timezoneOffsetInHours).toString() + ':00';
};

log4js.addLayout('json', function(config) {
  return function(logEvent) {
  	logEvent['startTime'] = dateToJSONWithTZ(logEvent['startTime']);
  	logEvent['message'] = util.format(...logEvent['data']);
  	delete logEvent['data'];
  	return JSON.stringify(logEvent);
  }
});

log4js.configure(config.get('log.filePath'));

var logger = log4js.getLogger('nodeJS');

if (config.get('log.options.replaceConsole')) {
	console.log = logger.info.bind(logger);
	console.info = logger.info.bind(logger);
	console.warn = logger.warn.bind(logger);
	console.error = logger.error.bind(logger);
	console.debug = logger.debug.bind(logger);
}
exports.getLogger = function (){
	return log4js.getLogger.apply(log4js, Array.prototype.slice.call(arguments));
};
exports.trace = function (){
	return logger.trace.apply(logger, Array.prototype.slice.call(arguments));
};
exports.debug = function (){
	return logger.debug.apply(logger, Array.prototype.slice.call(arguments));
};
exports.info = function (){
	return logger.info.apply(logger, Array.prototype.slice.call(arguments));
};
exports.warn = function (){
	return logger.warn.apply(logger, Array.prototype.slice.call(arguments));
};
exports.error = function (){
	return logger.error.apply(logger, Array.prototype.slice.call(arguments));
};
exports.fatal = function (){
	return logger.fatal.apply(logger, Array.prototype.slice.call(arguments));
};
exports.shutdown = function (callback) {
	return log4js.shutdown(callback);
};
