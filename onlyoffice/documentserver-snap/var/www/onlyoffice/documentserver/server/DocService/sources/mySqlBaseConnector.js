/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

var mysql = require('mysql2');
var sqlBase = require('./baseConnector');
const config = require('config');

const configSql = config.get('services.CoAuthoring.sql');
const cfgTableResult = config.get('services.CoAuthoring.sql.tableResult');

var pool  = mysql.createPool({
	host		: configSql.get('dbHost'),
	port		: configSql.get('dbPort'),
	user		: configSql.get('dbUser'),
	password	: configSql.get('dbPass'),
	database	: configSql.get('dbName'),
	charset		: configSql.get('charset'),
	connectionLimit	: configSql.get('connectionlimit'),
	timezone	: 'Z',
	flags : '-FOUND_ROWS'
});

exports.sqlQuery = function (ctx, sqlCommand, callbackFunction, opt_noModifyRes, opt_noLog, opt_values) {
	pool.getConnection(function(err, connection) {
		if (err) {
			ctx.logger.error('pool.getConnection error: %s', err);
			if (callbackFunction) callbackFunction(err, null);
			return;
		}
		let queryCallback = function (error, result) {
			connection.release();
			if (error) {
				ctx.logger.error('________________________error_____________________');
				ctx.logger.error('sqlQuery: %s sqlCommand: %s', error.code, sqlCommand);
				ctx.logger.error(error);
				ctx.logger.error('_____________________end_error_____________________');
			}
			if (callbackFunction) callbackFunction(error, result);
		};
		if(opt_values){
			connection.query(sqlCommand, opt_values, queryCallback);
		} else {
			connection.query(sqlCommand, queryCallback);
		}
	});
};
let addSqlParam = function (val, values) {
	values.push(val);
	return '?';
};
exports.addSqlParameter = addSqlParam;
let concatParams = function (val1, val2) {
  return `CONCAT(COALESCE(${val1}, ''), COALESCE(${val2}, ''))`;
};
exports.concatParams = concatParams;

exports.upsert = function(ctx, task, opt_updateUserIndex) {
	return new Promise(function(resolve, reject) {
		task.completeDefaults();
		let dateNow = new Date();
		let values = [];
		let cbInsert = task.callback;
		if (task.callback) {
			let userCallback = new sqlBase.UserCallback();
			userCallback.fromValues(task.userIndex, task.callback);
			cbInsert = userCallback.toSQLInsert();
		}
		let p0 = addSqlParam(task.tenant, values);
		let p1 = addSqlParam(task.key, values);
		let p2 = addSqlParam(task.status, values);
		let p3 = addSqlParam(task.statusInfo, values);
		let p4 = addSqlParam(dateNow, values);
		let p5 = addSqlParam(task.userIndex, values);
		let p6 = addSqlParam(task.changeId, values);
		let p7 = addSqlParam(cbInsert, values);
		let p8 = addSqlParam(task.baseurl, values);
		let p9 = addSqlParam(dateNow, values);
		var sqlCommand = `INSERT INTO ${cfgTableResult} (tenant, id, status, status_info, last_open_date, user_index, change_id, callback, baseurl)`+
			` VALUES (${p0}, ${p1}, ${p2}, ${p3}, ${p4}, ${p5}, ${p6}, ${p7}, ${p8}) ON DUPLICATE KEY UPDATE` +
			` last_open_date = ${p9}`;
		if (task.callback) {
			let p10 = addSqlParam(JSON.stringify(task.callback), values);
			sqlCommand += `, callback = CONCAT(callback , '${sqlBase.UserCallback.prototype.delimiter}{"userIndex":' , (user_index + 1) , ',"callback":', ${p10}, '}')`;
		}
		if (task.baseurl) {
			let p11 = addSqlParam(task.baseurl, values);
			sqlCommand += `, baseurl = ${p11}`;
		}
		if (opt_updateUserIndex) {
			sqlCommand += ', user_index = LAST_INSERT_ID(user_index + 1)';
		}
		sqlCommand += ';';

		exports.sqlQuery(ctx, sqlCommand, function(error, result) {
			if (error) {
				reject(error);
			} else {
				resolve(result);
			}
		}, undefined, undefined, values);
	});
};
