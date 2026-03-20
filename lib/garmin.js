const { GarminConnect } = require('garmin-connect');
const AdmZip = require('adm-zip');
const { getSecret } = require('./keychain');

async function createGarminClient() {
  const email = process.env.GARMIN_EMAIL;
  const password = getSecret('coachcarter-garmin');
  const client = new GarminConnect({ username: email, password });
  await client.login(email, password);
  return client;
}

async function getActivitiesSince(client, since) {
  const activities = await client.getActivities(0, 100);
  return activities.filter(a => new Date(a.startTimeGMT) > since);
}

// Downloads the activity zip from Garmin and returns the raw FIT buffer.
async function downloadFitFile(client, activityId) {
  const url = client.url.DOWNLOAD_ZIP + activityId;
  const zipBuffer = await client.client.get(url, { responseType: 'arraybuffer' });
  const zip = new AdmZip(Buffer.from(zipBuffer));
  const entry = zip.getEntries().find(e => e.entryName.endsWith('.fit'));
  if (!entry) throw new Error(`No .fit file found in zip for activity ${activityId}`);
  return entry.getData();
}

// Returns 'zwift' if identifiable as Zwift-sourced, else 'watch'.
function resolveSource(activity) {
  const typeKey = activity.activityType?.typeKey || '';
  if (typeKey === 'virtual_ride') return 'zwift';
  return 'watch';
}

// For days with multiple bike activities, prefer Zwift-sourced if identifiable.
// If both are 'watch' (source indeterminate), keep all — analyze both.
// Note: activities here are raw Garmin objects — use activityType.typeKey and startTimeLocal.
function deduplicateBikes(activities) {
  const isBike = a => {
    const key = a.activityType?.typeKey || '';
    return key.includes('cycling') || key === 'virtual_ride';
  };
  const getDate = a => a.startTimeLocal?.split(' ')[0] || a.startTimeGMT?.split(' ')[0];

  const bikes = activities.filter(isBike);
  const others = activities.filter(a => !isBike(a));

  const byDate = {};
  for (const a of bikes) {
    const date = getDate(a);
    if (!byDate[date]) byDate[date] = [];
    byDate[date].push(a);
  }

  const keep = [];
  for (const group of Object.values(byDate)) {
    if (group.length === 1) { keep.push(...group); continue; }
    const zwift = group.find(a => resolveSource(a) === 'zwift');
    if (zwift) {
      keep.push(zwift);
      console.log(`[garmin] Kept Zwift bike on ${getDate(group[0])}, dropped ${group.length - 1} watch duplicate(s)`);
    } else {
      keep.push(...group);
      console.log(`[garmin] Multiple bike activities on ${getDate(group[0])} — source unknown, keeping all`);
    }
  }

  return [...keep, ...others];
}

module.exports = { createGarminClient, getActivitiesSince, downloadFitFile, resolveSource, deduplicateBikes };
