import { energy } from './energy.js';
import { heating } from './heating.js';
import { settings } from './settings.js';
import { activity } from './activity.js';
import { boiler } from './boiler.js';
import { lighting } from './lighting.js';

// Each module owns its view and events; integrations and persistence stay on the server.
export const modules = [heating,boiler,energy,lighting,activity,settings];
