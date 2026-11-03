import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
import test from 'node:test';
const load = source => import(`data:text/javascript;base64,${Buffer.from(source).toString('base64')}`);
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const {selectBatteryTransport} = await load(read('../deviceconnection.js'));
const Constants = await load(read('../constants.js'));
const Utils = await load(read('../utils.js'));
const {RazerDevice} = await load(read('../razerdbushandler.js').replace(/^import .*$/gm, ''));
const radio = {_device_serial: 'radio', _device_name: 'Razer Naga V2 Pro (Wireless)', _is_online: true, _has_get_battery_method: true, _power_level: 0};
const usb = {...radio, _device_serial: 'usb', _device_name: 'Razer Naga V2 Pro (Wired)', _power_level: 78};

test('prefer a live USB battery over the matching idle receiver, without changing other mice', () => {
    assert.equal(selectBatteryTransport([radio, usb], radio), usb);
    assert.equal(selectBatteryTransport([radio, {...usb, _is_online: false}], radio), radio);
    assert.equal(selectBatteryTransport([radio, {...usb, _device_name: 'Other mouse (Wired)'}], radio), radio);
    assert.equal(selectBatteryTransport([radio, {...usb, _power_level: 0}], radio), radio);
});

globalThis.connectionTestDeps = {
    GObject: {registerClass: cls => cls}, PanelMenu: {Button: class {}},
    Constants, Utils, RazerDbusHandler: {RazerDevice}, selectBatteryTransport,
};
const {Indicator} = await load('const {GObject, PanelMenu, Constants, Utils, RazerDbusHandler, selectBatteryTransport} = globalThis.connectionTestDeps;\n' + read('../indicator.js').replace(/^import .*$/gm, ''));
function indicator() {
    const value = new Indicator();
    const settings = new Map();
    value._settings = {get_string: key => settings.get(key) ?? '', set_string: (key, v) => settings.set(key, v)};
    value._devices = [];
    value._device_popup_menus = [];
    value._battery_icon = {set_gicon() {}};
    value._percentage_label = {text: ''};
    value._max_power_history_count = 4;
    value.logDevelopment = value.LogState = () => {};
    value.logException = message => {throw new Error(message);};
    const pending = [];
    value._razer_dbus = Object.fromEntries(['GetDeviceName', 'GetDeviceType', 'Introspect', 'GetBatteryPower', 'GetIsCharging'].map(method =>
        [method, (...args) => pending.push({method, args})]));
    return {value, pending, settings};
}

test('USB hot-plug is added on the next list and marked online immediately', () => {
    const {value, pending} = indicator();
    value.onDeviceList(['radio']);
    value.onDeviceList(['radio', 'usb']);
    assert.deepEqual(value._devices.map(d => [d._device_serial, d._is_online]), [['radio', true], ['usb', true]]);
    assert.ok(pending.some(p => p.method === 'Introspect' && p.args[0] === 'usb'));
    const name = pending.find(p => p.method === 'GetDeviceName' && p.args[0] === 'usb');
    name.args[1]('usb', usb._device_name);
    assert.equal(value.getRazerDevice('usb')._device_name, usb._device_name);
});

test('disconnect prunes records and ignores delayed callbacks, including after reconnect', () => {
    const {value, pending} = indicator();
    value.onDeviceList(['usb']);
    const old = value.getRazerDevice('usb');
    const callback = pending.find(p => p.method === 'GetDeviceName').args[1];
    value.onDeviceList([]);
    assert.equal(value.getRazerDevice('usb'), null);
    value.onDeviceList(['usb']);
    callback('usb', 'stale name');
    assert.notEqual(value.getRazerDevice('usb'), old);
    assert.equal(value.getRazerDevice('usb')._device_name, '');
});

test('unknown battery replies never select a device or turn into a 0% reading', () => {
    const {value, settings} = indicator();
    value.onDeviceList(['usb']);
    value.onPowerStatus('usb', -1, true);
    assert.equal(settings.get(Constants.SCHEMA_BATTERY_DEVICE_SERIAL), undefined);
    value.onPowerStatus('usb', 78, false);
    assert.equal(value.getRazerDevice('usb')._power_level, 78);
    assert.equal(settings.get(Constants.SCHEMA_BATTERY_DEVICE_SERIAL), 'usb');
});

test('tray selects the online wired battery while preserving the configured receiver', () => {
    const {value, settings} = indicator();
    value._devices = [radio, usb];
    settings.set(Constants.SCHEMA_BATTERY_DEVICE_SERIAL, 'radio');
    assert.equal(value.getDefaultPowerDevice(), usb);
    assert.equal(settings.get(Constants.SCHEMA_BATTERY_DEVICE_SERIAL), 'radio');
    value._devices = [radio];
    assert.equal(value.getDefaultPowerDevice(), radio);
});

const requests = [];
const pageClass = property => class {
    constructor(prefs) {this.prefs = prefs;}
    createPage() {this[property] = {}; this.prefs._window.add(this[property]);}
};
let deviceSignal;
let poll;
let closed;
const unsubscribed = [];
globalThis.preferencesTestDeps = {
    ExtensionPreferences: class {},
    DpiPageHandler: {DpiPageHandler: pageClass('_settingsPage')},
    PowerPagehandler: {PowerPageHandler: pageClass('_powerPage')},
    LogoRgbPagehandler: {LogoRgbPageHandler: pageClass('_page')},
    AboutPagehandler: {AboutPageHandler: pageClass('_aboutPage')},
    RazerDbusHandler: {RazerDbusHandler: class {
        GetDevices(callback) { requests.push(callback); }
    }},
    Gio: {DBusSignalFlags: {NONE: 0}, DBus: {session: {
        signal_subscribe(...args) {deviceSignal = args.at(-1); return 12;},
        signal_unsubscribe(id) {unsubscribed.push(id);},
    }}},
    GLib: {PRIORITY_DEFAULT: 0, SOURCE_CONTINUE: true,
        timeout_add_seconds(_priority, _seconds, callback) {poll = callback; return 34;},
        Source: {remove(id) {unsubscribed.push(id);}}},
};
const {default: Preferences} = await load('const {ExtensionPreferences, DpiPageHandler, PowerPagehandler, LogoRgbPagehandler, AboutPagehandler, RazerDbusHandler, Gio, GLib} = globalThis.preferencesTestDeps;\n' +
    read('../prefs.js').replace(/^import .*$/gm, ''));

test('open preferences rebuilds on hot-plug and polling changes, ignores old replies and cleans up', () => {
    const prefs = Object.create(Preferences.prototype);
    const pages = new Set();
    const window = {
        add(page) {pages.add(page);}, remove(page) {assert.ok(pages.delete(page));},
        connect(_event, callback) {closed = callback;},
    };
    prefs.onDeviceList = list => {prefs._deviceListKey = [...list].sort().join('\n');};
    prefs.fillPreferencesWindow(window);
    requests.shift()(['radio']);
    assert.equal(pages.size, 4);
    poll();
    const stale = requests.shift();
    deviceSignal();
    requests.shift()(['radio', 'usb']);
    assert.equal(prefs._deviceListKey, 'radio\nusb');
    assert.equal(pages.size, 4);
    stale(['old']);
    assert.equal(prefs._deviceListKey, 'radio\nusb');
    poll();
    requests.shift()(['radio']);
    assert.equal(prefs._deviceListKey, 'radio');
    poll();
    const afterClose = requests.shift();
    closed();
    afterClose(['radio', 'usb']);
    assert.equal(prefs._deviceListKey, 'radio');
    assert.deepEqual(unsubscribed, [12, 34]);
});
