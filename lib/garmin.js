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
function deduplicateBikes(activities) {
  const bikes = activities.filter(a => a.sport === 'bike');
  const others = activities.filter(a => a.sport !== 'bike');

  const byDate = {};
  for (const a of bikes) {
    if (!byDate[a.date]) byDate[a.date] = [];
    byDate[a.date].push(a);
  }

  const keep = [];
  for (const group of Object.values(byDate)) {
    if (group.length === 1) { keep.push(...group); continue; }
    const zwift = group.find(a => resolveSource(a) === 'zwift');
    if (zwift) {
      keep.push(zwift);
      console.log(`[garmin] Kept Zwift bike on ${group[0].date}, dropped ${group.length - 1} watch duplicate(s)`);
    } else {
      keep.push(...group);
      console.log(`[garmin] Multiple bike activities on ${group[0].date} — source unknown, keeping all`);
    }
  }

  return [...keep, ...others];
}

module.exports = { createGarminClient, getActivitiesSince, downloadFitFile, resolveSource, deduplicateBikes };
