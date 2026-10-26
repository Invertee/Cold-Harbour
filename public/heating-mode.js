// Keep the existing ESPHome wire labels compatible; use clear names in the app.
export const modeName=value=>String(value || '').replace(/Comfort heating paused/g,'Central heating paused').replace(/Cold Harbour unavailable: PID/g,'Smart Thermostat unavailable: Local PID').replace(/Cold Harbour/g,'Smart Thermostat').replace(/\bPID\b/g,'Local PID').replace(/Local Local PID/g,'Local PID');
