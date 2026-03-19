// lib/supabase.js
const { createClient } = require('@supabase/supabase-js');
const { getSecret } = require('./keychain');

let _client = null;

function getSupabase() {
  if (!_client) {
    const url = process.env.SUPABASE_URL;
    if (!url) throw new Error('SUPABASE_URL not set in environment');
    const key = getSecret('coachcarter-supabase');
    _client = createClient(url, key);
  }
  return _client;
}

module.exports = { getSupabase };
