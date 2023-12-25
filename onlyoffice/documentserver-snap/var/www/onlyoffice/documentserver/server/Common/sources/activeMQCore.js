/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */

'use strict';
var config = require('config');
var container = require('rhea');
var logger = require('./logger');
const operationContext = require('./operationContext');

const cfgRabbitSocketOptions = config.get('activemq.connectOptions');

var RECONNECT_TIMEOUT = 1000;

function connetPromise(closeCallback) {
  return new Promise(function(resolve, reject) {
    function startConnect() {
      let onDisconnected = function() {
        if (isConnected) {
          closeCallback();
        } else {
          setTimeout(startConnect, RECONNECT_TIMEOUT);
        }
      }
      let conn = container.create_container().connect(cfgRabbitSocketOptions);
      let isConnected = false;
      conn.on('connection_open', function(context) {
        operationContext.global.logger.debug('[AMQP] connected');
        isConnected = true;
        resolve(conn);
      });
      conn.on('connection_error', function(context) {
        operationContext.global.logger.debug('[AMQP] connection_error %s', context.error && context.error);
      });
      conn.on('connection_close', function(context) {
        operationContext.global.logger.debug('[AMQP] conn close');
        if (onDisconnected) {
          onDisconnected();
          onDisconnected = null;
        }
      });
      conn.on('disconnected', function(context) {
        operationContext.global.logger.error('[AMQP] disconnected %s', context.error && context.error.stack);
        if (onDisconnected) {
          onDisconnected();
          onDisconnected = null;
        }
      });
    }

    startConnect();
  });
}
function openSenderPromise(conn, options) {
  return new Promise(function(resolve, reject) {
    resolve(conn.open_sender(options));
  });
}
function openReceiverPromise(conn, options) {
  return new Promise(function(resolve, reject) {
    resolve(conn.open_receiver(options));
  });
}
function closePromise(conn) {
  return new Promise(function(resolve, reject) {
    conn.close();
    resolve();
  });
}

module.exports.connetPromise = connetPromise;
module.exports.openSenderPromise = openSenderPromise;
module.exports.openReceiverPromise = openReceiverPromise;
module.exports.closePromise = closePromise;
module.exports.RECONNECT_TIMEOUT = RECONNECT_TIMEOUT;
