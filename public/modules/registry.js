import { energy } from './energy.js';
import { heating } from './heating.js';
import { settings } from './settings.js';
import { activity } from './activity.js';
import { boiler } from './boiler.js';

// Each module owns its view and events; integrations and persistence stay on the server.
export const modules = [boiler,heating,energy,activity,settings];
