import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { join } from 'node:path';
import { randomBytes, createCipheriv, createDecipheriv, randomUUID } from 'node:crypto';
import { defaults, sampleRooms, sampleRules } from './defaults.js';
import {migrateHeatingPlan,upgradeHeatingPlan,groupHeatingSchedules} from './heating-plan.js';
import {defaultWeatherPlan} from './smart-thermostat.js';

export function createStore(directory) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const keyPath = join(directory, 'secrets.key');
  if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const key = readFileSync(keyPath);
  const db = new DatabaseSync(join(directory, 'mods.sqlite'));
  try { chmodSync(join(directory, 'mods.sqlite'), 0o600); } catch { /* Windows uses inherited ACLs. */ }
  db.exec(`
    PRAGMA journal_mode=WAL;
    PRAGMA busy_timeout=5000;
    CREATE TABLE IF NOT EXISTS migrations (version INTEGER PRIMARY KEY);
    CREATE TABLE IF NOT EXISTS settings (section TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS secrets (name TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS rules (id TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS readings (source TEXT NOT NULL, at TEXT NOT NULL, watts REAL NOT NULL, PRIMARY KEY(source,at));
    CREATE TABLE IF NOT EXISTS consumption (meter TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL, kwh REAL NOT NULL, PRIMARY KEY(meter,start));
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, at TEXT NOT NULL, kind TEXT NOT NULL, message TEXT NOT NULL);
  `);
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=1').get()) {
    db.exec('BEGIN');
    try {
      for (const [section,value] of Object.entries(defaults)) db.prepare('INSERT INTO settings VALUES (?,?)').run(section, JSON.stringify(value));
      for (const room of sampleRooms) db.prepare('INSERT INTO rooms VALUES (?,?)').run(room.id, JSON.stringify(room));
      for (const rule of sampleRules) db.prepare('INSERT INTO rules VALUES (?,?)').run(rule.id, JSON.stringify(rule));
      db.prepare('INSERT INTO migrations VALUES (1)').run();
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=2').get()) {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('energy',JSON.stringify(defaults.energy));
      db.exec(`
        CREATE TABLE energy_intervals (
          source TEXT NOT NULL, fuel TEXT NOT NULL, start TEXT NOT NULL, end TEXT NOT NULL,
          kwh REAL, cost REAL, quality INTEGER NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(source,fuel,start)
        );
        CREATE TABLE energy_days (
          source TEXT NOT NULL, fuel TEXT NOT NULL, day TEXT NOT NULL, kwh REAL, cost REAL,
          standing_charge REAL, quality INTEGER NOT NULL, updated_at TEXT NOT NULL,
          PRIMARY KEY(source,fuel,day)
        );
        INSERT INTO migrations VALUES (2);
      `);
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=3').get()) {
    db.exec(`BEGIN;
      ALTER TABLE energy_days ADD COLUMN usage_quality INTEGER NOT NULL DEFAULT 0;
      ALTER TABLE energy_days ADD COLUMN cost_quality INTEGER NOT NULL DEFAULT 0;
      UPDATE energy_days SET usage_quality=CASE WHEN kwh IS NULL THEN 0 ELSE quality END,
        cost_quality=CASE WHEN cost IS NULL THEN 0 ELSE quality END;
      INSERT INTO migrations VALUES (3);
      COMMIT;`);
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=4').get()) {
    db.exec('BEGIN');
    try {
      const row = db.prepare("SELECT value FROM settings WHERE section='heating'").get();
      const heating = {...defaults.heating,...JSON.parse(row?.value || '{}'),enabled:false};
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('heating',JSON.stringify(heating));
      db.prepare('INSERT INTO migrations VALUES (4)').run();
      db.prepare('INSERT INTO events (at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(),'heating','Room demand control installed in preview mode. Review room mappings and proposed targets before enabling thermostat control.');
      db.exec('COMMIT');
    } catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=5').get()) {
    db.exec('BEGIN');
    try {
      db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('boiler',JSON.stringify(defaults.boiler));
      db.exec(`CREATE TABLE boiler_devices (device_id TEXT PRIMARY KEY,last_seen TEXT NOT NULL,mode TEXT NOT NULL,telemetry TEXT NOT NULL);
        CREATE TABLE boiler_sessions (device_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,last_seen TEXT NOT NULL,PRIMARY KEY(device_id,boot_id));
        CREATE TABLE boiler_samples (device_id TEXT NOT NULL,at TEXT NOT NULL,telemetry TEXT NOT NULL,PRIMARY KEY(device_id,at));
        INSERT INTO migrations VALUES (5);`);
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  if (!db.prepare('SELECT 1 FROM migrations WHERE version=6').get()) {
    db.exec('BEGIN');
    try {
      // Only keep settings used by the listener. Room mappings, history and HA credentials survive.
      for (const [section, initial] of Object.entries(defaults)) {
        const row=db.prepare('SELECT value FROM settings WHERE section=?').get(section);
        const previous=JSON.parse(row?.value || '{}');
        const next=Object.fromEntries(Object.entries(initial).map(([name,value])=>[name,previous[name] ?? value]));
        if(section==='general')next.mode='listen';
        db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(section,JSON.stringify(next));
      }
      db.prepare("DELETE FROM settings WHERE section='octopus'").run();
      db.prepare("DELETE FROM secrets WHERE name='octopusKey'").run();
      db.exec(`CREATE TABLE boiler_exchanges (
        device_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,at TEXT NOT NULL,mode TEXT NOT NULL,telemetry TEXT NOT NULL,
        PRIMARY KEY(device_id,boot_id,sequence));
        CREATE INDEX boiler_exchanges_time ON boiler_exchanges(device_id,at);
        CREATE TABLE boiler_frames (
        device_id TEXT NOT NULL,boot_id TEXT NOT NULL,sequence INTEGER NOT NULL,received_at TEXT NOT NULL,at TEXT NOT NULL,
        direction TEXT NOT NULL,type INTEGER NOT NULL,data_id INTEGER NOT NULL,data INTEGER NOT NULL,
        PRIMARY KEY(device_id,boot_id,sequence));
        CREATE INDEX boiler_frames_time ON boiler_frames(device_id,received_at);
        INSERT INTO migrations VALUES (6);`);
      db.prepare('INSERT INTO events (at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(),'system','Listen-only monitoring installed. Heating commands and direct Octopus access removed; local ESP PID retains control.');
      db.exec('COMMIT');
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=7').get()){
    db.exec('BEGIN');
    try{
      const rooms=db.prepare('SELECT value FROM rooms ORDER BY rowid').all().map(r=>JSON.parse(r.value)),rules=db.prepare('SELECT value FROM rules ORDER BY rowid').all().map(r=>JSON.parse(r.value));
      const old=JSON.parse(db.prepare("SELECT value FROM settings WHERE section='heating'").get()?.value || '{}');
      const plan=migrateHeatingPlan(rooms,rules,old.activity);
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('heatingPlan',JSON.stringify(plan));
      for(const room of rooms){room.targetOffset=Math.round((room.comfort-20)*100)/100;room.awayOffset=Math.round((room.eco-16)*100)/100;db.prepare('UPDATE rooms SET value=? WHERE id=?').run(JSON.stringify(room),room.id);}
      db.exec(`CREATE TABLE heating_samples (at TEXT PRIMARY KEY,snapshot TEXT NOT NULL);INSERT INTO migrations VALUES (7);`);
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=8').get()){
    db.exec('BEGIN');
    try{
      const previous=JSON.parse(db.prepare("SELECT value FROM settings WHERE section='heatingPlan'").get().value);
      const rooms=db.prepare('SELECT value FROM rooms ORDER BY rowid').all().map(row=>JSON.parse(row.value));
      db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('heatingPlanBeforePriority',JSON.stringify(previous));
      db.prepare('UPDATE settings SET value=? WHERE section=?').run(JSON.stringify(upgradeHeatingPlan(previous,rooms)),'heatingPlan');
      db.prepare('INSERT INTO migrations VALUES (8)').run();
      db.prepare('INSERT INTO events (at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(),'heating','Smart Thermostat planning installed. Schedules now select high/low priority; high uses the house target and low uses setback. Previous plan archived. Boiler control remains Local PID.');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=9').get()){
    db.exec('BEGIN');
    try{
      const previous=JSON.parse(db.prepare("SELECT value FROM settings WHERE section='heatingPlan'").get().value);
      db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('heatingPlanBeforeOccupancySchedules',JSON.stringify(previous));
      db.prepare('UPDATE settings SET value=? WHERE section=?').run(JSON.stringify(groupHeatingSchedules(previous)),'heatingPlan');
      db.prepare('INSERT INTO migrations VALUES (9)').run();
      db.prepare('INSERT INTO events (at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(),'heating','Home and away schedules now each use weekday/weekend groups. Monday and Saturday plans represent the groups; previous individual days archived. Planning only; Local PID retains control.');
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=10').get()){
    db.exec('BEGIN');
    try{
      const plan=JSON.parse(db.prepare("SELECT value FROM settings WHERE section='heatingPlan'").get().value);
      plan.weather={...defaultWeatherPlan,...plan.weather};
      db.prepare('UPDATE settings SET value=? WHERE section=?').run(JSON.stringify(plan),'heatingPlan');
      db.prepare('INSERT INTO migrations VALUES (10)').run();
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=11').get()){
    db.exec('BEGIN');
    try{
      db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run('thermostat',JSON.stringify({mode:'planning'}));
      db.prepare('INSERT INTO migrations VALUES (11)').run();
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  if(!db.prepare('SELECT 1 FROM migrations WHERE version=12').get()){
    db.exec('BEGIN');
    try{
      db.prepare('INSERT OR IGNORE INTO settings VALUES (?,?)').run('notifications',JSON.stringify(defaults.notifications));
      db.prepare('INSERT INTO migrations VALUES (12)').run();
      db.exec('COMMIT');
    }catch(error){db.exec('ROLLBACK');throw error;}
  }
  return {
    db,
    config() { return Object.fromEntries(db.prepare('SELECT * FROM settings').all().filter(row=>Object.hasOwn(defaults,row.section)).map(row => {const saved=JSON.parse(row.value);return [row.section,Object.fromEntries(Object.entries(defaults[row.section]).map(([key,value])=>[key,saved[key] ?? value]))];})); },
    save(section, value) { db.prepare('INSERT OR REPLACE INTO settings VALUES (?,?)').run(section, JSON.stringify(value)); },
    secret(name, value) {
      if (value !== undefined) {
        if (!value) { db.prepare('DELETE FROM secrets WHERE name=?').run(name); return ''; }
        const iv = randomBytes(12);
        const cipher = createCipheriv('aes-256-gcm', key, iv);
        const encrypted = Buffer.concat([cipher.update(value, 'utf8'), cipher.final()]);
        db.prepare('INSERT OR REPLACE INTO secrets VALUES (?,?)').run(name, Buffer.concat([iv, cipher.getAuthTag(), encrypted]).toString('base64'));
      }
      const row = db.prepare('SELECT value FROM secrets WHERE name=?').get(name);
      if (!row) return '';
      const payload = Buffer.from(row.value, 'base64');
      const decipher = createDecipheriv('aes-256-gcm', key, payload.subarray(0,12));
      decipher.setAuthTag(payload.subarray(12,28));
      return Buffer.concat([decipher.update(payload.subarray(28)), decipher.final()]).toString('utf8');
    },
    list(table) { if (!['rooms','rules'].includes(table)) throw new Error('Invalid table'); return db.prepare(`SELECT value FROM ${table} ORDER BY rowid`).all().map(row => JSON.parse(row.value)); },
    put(table, value) {
      if (!['rooms','rules'].includes(table)) throw new Error('Invalid table');
      const record = { ...value, id: value.id || randomUUID() };
      db.prepare(`INSERT INTO ${table} VALUES (?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value`).run(record.id, JSON.stringify(record));
      return record;
    },
    remove(table, id) {
      if (!['rooms','rules'].includes(table)) throw new Error('Invalid table');
      if (table === 'rooms') {
        for (const rule of this.list('rules')) if (rule.roomId === id) this.remove('rules',rule.id);
      }
      db.prepare(`DELETE FROM ${table} WHERE id=?`).run(id);
    },
    log(kind, message) { db.prepare('INSERT INTO events (at,kind,message) VALUES (?,?,?)').run(new Date().toISOString(),kind,message); },
    events() { return db.prepare('SELECT * FROM events ORDER BY id DESC LIMIT 40').all(); },
    prune(now = Date.now()) {
      db.prepare('DELETE FROM readings WHERE at < ?').run(new Date(now - 14*86400000).toISOString());
      db.prepare('DELETE FROM consumption WHERE start < ?').run(new Date(now - 400*86400000).toISOString());
      db.prepare('DELETE FROM energy_intervals WHERE start < ?').run(new Date(now - 400*86400000).toISOString());
      db.prepare('DELETE FROM energy_days WHERE day < ?').run(new Date(now - 400*86400000).toISOString().slice(0,10));
      db.prepare('DELETE FROM events WHERE id NOT IN (SELECT id FROM events ORDER BY id DESC LIMIT 1000)').run();
      const boilerCutoff=new Date(now-this.config().boiler.historyDays*86400000).toISOString();
      db.prepare('DELETE FROM boiler_samples WHERE at < ?').run(boilerCutoff);
      db.prepare('DELETE FROM boiler_sessions WHERE last_seen < ?').run(boilerCutoff);
      db.prepare('DELETE FROM boiler_exchanges WHERE at < ?').run(new Date(now-7*86400000).toISOString());
      db.prepare('DELETE FROM boiler_frames WHERE received_at < ?').run(new Date(now-86400000).toISOString());
      db.prepare('DELETE FROM heating_samples WHERE at < ?').run(new Date(now-90*86400000).toISOString());
    },
    close() { db.close(); },
  };
}
