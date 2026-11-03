// A receiver can remain enumerated while the same mouse is attached over USB.
// Keep the user's selection, but use the live wired transport for its battery.
export function selectBatteryTransport(devices, selected) {
    if (!selected) return null;
    const model = name => name.replace(/\s*\((?:wired|wireless)\)\s*$/i, '').trim();
    const peer = devices.find(device => device !== selected && device._is_online &&
        device._has_get_battery_method && model(device._device_name) === model(selected._device_name) &&
        /\(wired\)\s*$/i.test(device._device_name) && Number.isFinite(device._power_level) &&
        device._power_level > 0);
    return peer ?? selected;
}
