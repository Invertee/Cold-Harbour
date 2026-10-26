import {defaultHeatingPlan} from './heating-plan.js';
export const defaults = {
  general: { mode: 'listen', timezone: 'Europe/London' },
  homeAssistant: { url: '', powerEntity: '', captureEntity: '' },
  notifications: { enabled: false, targets: [] },
  energy: {
    electricityMeter:'', gasMeter:'',
    electricityDemand:'', electricityToday:'', electricityTodayCost:'', electricityPrevious:'', electricityPreviousCost:'', electricityRate:'',
    gasToday:'', gasTodayCost:'', gasPrevious:'', gasPreviousCost:'', gasRate:'',
  },
  heating: { activity: 'auto', staleMinutes: 30 },
  heatingPlan:defaultHeatingPlan,
  boiler: { deviceId:'boiler-controller', historyDays:30 },
  thermostat: {mode:'planning'},
};

export const sampleRooms = [
  { id: 'living', name: 'Living room', sensorEntity: '', occupancyEntity: '', comfort: 21, eco: 17, weight: 1, icon: 'sofa' },
  { id: 'office', name: 'Office', sensorEntity: '', occupancyEntity: '', comfort: 20.5, eco: 17, weight: 1, icon: 'desk' },
  { id: 'bedroom', name: 'Bedroom', sensorEntity: '', occupancyEntity: '', comfort: 18, eco: 16, weight: 1, icon: 'bed' },
  { id: 'kitchen', name: 'Kitchen', sensorEntity: '', occupancyEntity: '', comfort: 20, eco: 17, weight: 0.7, icon: 'cup' },
];

export const sampleRules = [
  { id: 'morning', name: 'A good start', roomId: 'kitchen', days: [1,2,3,4,5,6,0], start: '06:30', end: '09:00', target: 20, priority: 3, activity: 'home', enabled: true },
  { id: 'working', name: 'Working from home', roomId: 'office', days: [1,2,3,4,5], start: '09:00', end: '17:30', target: 20.5, priority: 4, activity: 'work', enabled: true },
  { id: 'evening', name: 'Put your feet up', roomId: 'living', days: [0,1,2,3,4,5,6], start: '17:30', end: '22:30', target: 21, priority: 4, activity: 'evening', enabled: true },
  { id: 'night', name: 'Lights out', roomId: 'bedroom', days: [0,1,2,3,4,5,6], start: '22:30', end: '06:30', target: 18, priority: 4, activity: 'sleep', enabled: true },
];
