/*
 * Copyright (C) undefined 2012-2023. All rights reserved
 *
 * undefined 
 *
 * Version: 7.5.1 (build:0)
 */


'use strict';

const constants = require('./constants');

const buildDate = '12/20/2023';
const oBuildDate = new Date(buildDate);

exports.readLicense = function*() {
	const c_LR = constants.LICENSE_RESULT;
	var now = new Date();
	var startDate = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));//first day of current month
	return [{
		count: 1,
		type: c_LR.Success,
		light: false,
		packageType: constants.PACKAGE_TYPE_OS,
		mode: constants.LICENSE_MODE.None,
		branding: false,
		connections: constants.LICENSE_CONNECTIONS,
		connectionsView: constants.LICENSE_CONNECTIONS,
		customization: false,
		advancedApi: false,
		usersCount: 0,
		usersViewCount: 0,
		usersExpire: constants.LICENSE_EXPIRE_USERS_ONE_DAY,
		hasLicense: false,
		plugins: false,
		buildDate: oBuildDate,
		startDate: startDate,
		endDate: null,
		customerId: "",
		alias: ""
	}, null];
};

exports.packageType = constants.PACKAGE_TYPE_OS;
