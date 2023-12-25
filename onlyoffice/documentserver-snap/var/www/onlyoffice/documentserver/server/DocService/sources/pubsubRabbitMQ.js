/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';
var config = require('config');
var events = require('events');
var util = require('util');
var co = require('co');
var constants = require('./../../Common/sources/constants');
const commonDefines = require('./../../Common/sources/commondefines');
var utils = require('./../../Common/sources/utils');
var rabbitMQCore = require('./../../Common/sources/rabbitMQCore');
var activeMQCore = require('./../../Common/sources/activeMQCore');

const cfgQueueType = config.get('queue.type');
var cfgRabbitExchangePubSub = config.get('rabbitmq.exchangepubsub');
var cfgActiveTopicPubSub = constants.ACTIVEMQ_TOPIC_PREFIX + config.get('activemq.topicpubsub');

const optionsExchange = {durable: true};
function initRabbit(pubsub, callback) {
  return co(function* () {
    var e = null;
    try {
      var conn = yield rabbitMQCore.connetPromise(function() {
        clear(pubsub);
        if (!pubsub.isClose) {
          setTimeout(() => {
            init(pubsub, null);
          }, rabbitMQCore.RECONNECT_TIMEOUT);
        }
      });
      pubsub.connection = conn;
      pubsub.channelPublish = yield rabbitMQCore.createChannelPromise(conn);
      pubsub.exchangePublish = yield rabbitMQCore.assertExchangePromise(pubsub.channelPublish, cfgRabbitExchangePubSub,
        'fanout', {durable: true});

      pubsub.channelReceive = yield rabbitMQCore.createChannelPromise(conn);
      var queue = yield rabbitMQCore.assertQueuePromise(pubsub.channelReceive, '', {autoDelete: true, exclusive: true});
      pubsub.channelReceive.bindQueue(queue, cfgRabbitExchangePubSub, '');
      yield rabbitMQCore.consumePromise(pubsub.channelReceive, queue, function (message) {
        if(null != pubsub.channelReceive){
          if (message) {
            pubsub.emit('message', message.content.toString());
          }
          pubsub.channelReceive.ack(message);
        }
      }, {noAck: false});
      yield repeat(pubsub);
    } catch (err) {
      e = err;
    }
    if (callback) {
      callback(e);
    }
  });
}
function initActive(pubsub, callback) {
  return co(function*() {
    var e = null;
    try {
      var conn = yield activeMQCore.connetPromise(function() {
        clear(pubsub);
        if (!pubsub.isClose) {
          setTimeout(() => {
            init(pubsub, null);
          }, activeMQCore.RECONNECT_TIMEOUT);
        }
      });
      pubsub.connection = conn;
      let optionsPubSubSender = {
        target: {
          address: cfgActiveTopicPubSub,
          capabilities: ['topic']
        }
      };
      pubsub.channelPublish = yield activeMQCore.openSenderPromise(conn, optionsPubSubSender);

      let optionsPubSubReceiver = {
        source: {
          address: cfgActiveTopicPubSub,
          capabilities: ['topic']
        },
        credit_window: 0,
        autoaccept: false
      };
      let receiver = yield activeMQCore.openReceiverPromise(conn, optionsPubSubReceiver);
      receiver.add_credit(1);
      receiver.on("message", function(context) {
        if (context) {
          pubsub.emit('message', context.message.body);
        }

        context.delivery.accept();
        receiver.add_credit(1);
      });
      yield repeat(pubsub);
    } catch (err) {
      e = err;
    }
    if (callback) {
      callback(e);
    }
  });
}
function clear(pubsub) {
  pubsub.channelPublish = null;
  pubsub.exchangePublish = null;
  pubsub.channelReceive = null;
}
function repeat(pubsub) {
  return co(function*() {
    for (var i = 0; i < pubsub.publishStore.length; ++i) {
      yield publish(pubsub, pubsub.publishStore[i]);
    }
    pubsub.publishStore.length = 0;
  });

}
function publishRabbit(pubsub, data) {
  return new Promise(function (resolve, reject) {
    let keepSending = pubsub.channelPublish.publish(pubsub.exchangePublish, '', data);
    if (!keepSending) {
      pubsub.channelPublish.once('drain', resolve);
    } else {
      resolve();
    }
  });
}

function publishActive(pubsub, data) {
  return new Promise(function (resolve, reject) {
    let sendable = pubsub.channelPublish.sendable();
    if (!sendable) {
      pubsub.channelPublish.once('sendable', () => {
        resolve(publishActive(pubsub, data));
      });
    } else {
      pubsub.channelPublish.send({durable: true, body: data});
      resolve();
    }
  });
}
function closeRabbit(conn) {
  return rabbitMQCore.closePromise(conn);
}
function closeActive(conn) {
  return activeMQCore.closePromise(conn);
}

function healthCheckRabbit(pubsub) {
  return co(function* () {
    if (!pubsub.channelPublish) {
      return false;
    }
    const exchange = yield rabbitMQCore.assertExchangePromise(pubsub.channelPublish, cfgRabbitExchangePubSub,
      'fanout', optionsExchange);
    return !!exchange;
  });
}
function healthCheckActive(pubsub) {
  return co(function* () {
    if (!pubsub.connection) {
      return false;
    }
    return pubsub.connection.is_open();
  });
}

let init;
let publish;
let close;
let healthCheck;
if (commonDefines.c_oAscQueueType.rabbitmq === cfgQueueType) {
  init = initRabbit;
  publish = publishRabbit;
  close = closeRabbit;
  healthCheck = healthCheckRabbit;
} else {
  init = initActive;
  publish = publishActive;
  close = closeActive;
  healthCheck = healthCheckActive;
}

function PubsubRabbitMQ() {
  this.isClose = false;
  this.connection = null;
  this.channelPublish = null;
  this.exchangePublish = null;
  this.channelReceive = null;
  this.publishStore = [];
}
util.inherits(PubsubRabbitMQ, events.EventEmitter);
PubsubRabbitMQ.prototype.init = function (callback) {
  init(this, callback);
};
PubsubRabbitMQ.prototype.initPromise = function() {
  var t = this;
  return new Promise(function(resolve, reject) {
    init(t, function(err) {
      if (err) {
        reject(err);
      } else {
        resolve();
      }
    });
  });
};
PubsubRabbitMQ.prototype.publish = function (message) {
  const data = Buffer.from(message);
  if (null != this.channelPublish) {
    return publish(this, data);
  } else {
    this.publishStore.push(data);
    return Promise.resolve();
  }
};
PubsubRabbitMQ.prototype.close = function() {
  this.isClose = true;
  return close(this.connection);
};
PubsubRabbitMQ.prototype.healthCheck = function() {
  return healthCheck(this);
};

module.exports = PubsubRabbitMQ;
