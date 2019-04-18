/**
 * @flow
 * @format
 * */

/**
 * External dependencies
 */
import childProcess from 'child_process';
import wd from 'wd';

/**
 * Internal dependencies
 */
import serverConfigs from './serverConfigs';
import { ios12, android8 } from './caps';
import AppiumLocal from './appium-local';
import _ from 'underscore';

// Platform setup
const defaultPlatform = 'android';
const rnPlatform = process.env.TEST_RN_PLATFORM || defaultPlatform;

// Environment setup, local environment or Sauce Labs
const defaultEnvironment = 'local';
const testEnvironment = process.env.TEST_ENV || defaultEnvironment;

// Local App Paths
const defaultAndroidAppPath = './android/app/build/outputs/apk/debug/app-debug.apk';
const defaultIOSAppPath = './ios/build/gutenberg/Build/Products/Release-iphonesimulator/gutenberg.app';

const localAndroidAppPath = process.env.ANDROID_APP_PATH || defaultAndroidAppPath;
const localIOSAppPath = process.env.IOS_APP_PATH || defaultIOSAppPath;

const localAppiumPort = serverConfigs.local.port; // Port to spawn appium process for local runs
let appiumProcess: ?childProcess.ChildProcess;

// Used to map unicode and special values to keycodes on Android
// Docs for keycode values: https://developer.android.com/reference/android/view/KeyEvent.html
const strToKeycode = {
	'\n': 66,
	'\u0008': 67,
};

const timer = ( ms: number ) => new Promise < {} > ( ( res ) => setTimeout( res, ms ) );

const isAndroid = () => {
	return rnPlatform.toLowerCase() === 'android';
};

const isLocalEnvironment = () => {
	return testEnvironment.toLowerCase() === 'local';
};

// Initialises the driver and desired capabilities for appium
const setupDriver = async () => {
	if ( isLocalEnvironment() ) {
		try {
			appiumProcess = await AppiumLocal.start( localAppiumPort );
		} catch ( err ) {
			// Ignore error here, Appium is probably already running (Appium desktop has its own server for instance)
			// eslint-disable-next-line no-console
			console.log( 'Could not start Appium server', err.toString() );
		}
	}

	const serverConfig = isLocalEnvironment() ? serverConfigs.local : serverConfigs.sauce;
	const driver = wd.promiseChainRemote( serverConfig );

	let desiredCaps;
	if ( isAndroid() ) {
		desiredCaps = _.clone( android8 );
		if ( isLocalEnvironment() ) {
			desiredCaps.app = localAndroidAppPath;
			try {
				const androidVersion = childProcess
					.execSync( 'adb shell getprop ro.build.version.release' )
					.toString()
					.replace( /^\s+|\s+$/g, '' );
				if ( ! isNaN( androidVersion ) ) {
					delete desiredCaps.platformVersion;
					// eslint-disable-next-line no-console
					console.log( 'Detected Android device running Android %s', androidVersion );
				}
			} catch ( error ) {
				// ignore error
			}
		} else {
			desiredCaps.app = 'sauce-storage:Gutenberg.apk'; // App should be preloaded to sauce storage, this can also be a URL
		}
	} else {
		desiredCaps = _.clone( ios12 );
		if ( isLocalEnvironment() ) {
			desiredCaps.app = localIOSAppPath;
		} else {
			desiredCaps.app = 'sauce-storage:Gutenberg.app.zip'; // App should be preloaded to sauce storage, this can also be a URL
		}
	}

	if ( ! isLocalEnvironment() ) {
		const branch = process.env.CIRCLE_BRANCH || '';
		desiredCaps.name = `Gutenberg Editor Tests[${ rnPlatform }]-${ branch }`;
		desiredCaps.tags = [ 'Gutenberg', branch ];
	}

	await driver.init( desiredCaps );

	const status = await driver.status();
	// Display the driver status
	// eslint-disable-next-line no-console
	console.log( status );

	await driver.setImplicitWaitTimeout( 2000 );
	await timer( 3000 );
	return driver;
};

const stopDriver = async ( driver: wd.PromiseChainWebdriver ) => {
	if ( driver === undefined ) {
		return;
	}
	await driver.quit();

	if ( appiumProcess !== undefined ) {
		await AppiumLocal.stop( appiumProcess );
	}
};

// attempts to type a string to a given element, need for this stems from
// https://github.com/appium/appium/issues/12285#issuecomment-471872239
// https://github.com/facebook/WebDriverAgent/issues/1084
const typeString = async ( driver: wd.PromiseChainWebdriver, element: wd.PromiseChainWebdriver.Element, str: string, clear: boolean = false ) => {
	if ( clear ) {
		await element.clear();
	}

	if ( isAndroid() ) {
		if ( str in strToKeycode ) {
			return await driver.pressKeycode( strToKeycode[ str ] );
		}
		const paragraphs = str.split( '\n' );

		if ( paragraphs.length > 1 ) {
			for ( let i = 0; i < paragraphs.length; i++ ) {
				const paragraph = paragraphs[ i ].replace( /[ ]/g, '%s' );
				if ( paragraph in strToKeycode ) {
					await driver.driver.pressKeycode( strToKeycode[ paragraph ] );
				} else {
					await driver.execute( 'mobile: shell', { command: 'input', args: [ 'text', paragraph ] } );
				}
				if ( i !== paragraphs.length - 1 ) {
					await driver.pressKeycode( strToKeycode[ '\n' ] );
				}
			}
		} else {
			await driver.execute( 'mobile: shell', { command: 'input', args: [ 'text', str.replace( /[ ]/g, '%s' ) ] } );
		}
	} else {
		return await element.type( str );
	}
};

// Calculates middle x,y and clicks that position
const clickMiddleOfElement = async ( driver: wd.PromiseChainWebdriver, element: wd.PromiseChainWebdriver.Element ) => {
	const location = await element.getLocation();
	const size = await element.getSize();

	const action = await new wd.TouchAction( driver );
	action.press( { x: location.x + ( size.width / 2 ), y: location.y } );
	action.release();
	await action.perform();
};

// Clicks in the top left of an element
const clickBeginningOfElement = async ( driver: wd.PromiseChainWebdriver, element: wd.PromiseChainWebdriver.Element ) => {
	const location = await element.getLocation();
	const action = await new wd.TouchAction( driver );
	action.press( { x: location.x, y: location.y } );
	action.release();
	await action.perform();
};

// Starts from the middle of the screen or the element(if specified)
// and swipes upwards
const swipeUp = async ( driver: wd.PromiseChainWebdriver, element: wd.PromiseChainWebdriver.Element = undefined ) => {
	let size = await driver.getWindowSize();
	let y = 0;
	if ( element !== undefined ) {
		size = await element.getSize();
		const location = await element.getLocation();
		y = location.y;
	}

	const startX = size.width / 2;
	const startY = y + ( size.height / 3 );
	const endX = startX;
	const endY = startY + ( startY * -1 * 0.5 );

	const action = await new wd.TouchAction( driver );
	action.press( { x: startX, y: startY } );
	action.wait( 3000 );
	action.moveTo( { x: endX, y: endY } );
	action.release();
	await action.perform();
};

module.exports = {
	timer,
	setupDriver,
	isLocalEnvironment,
	isAndroid,
	typeString,
	clickMiddleOfElement,
	clickBeginningOfElement,
	swipeUp,
	stopDriver,
};
