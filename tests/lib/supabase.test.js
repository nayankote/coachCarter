// tests/lib/supabase.test.js
// Use jest.isolateModules to control module registry per test (required for singleton testing)

test('creates client with SUPABASE_URL and Keychain service key', () => {
  jest.isolateModules(() => {
    jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn().mockReturnValue({ from: jest.fn() }) }));
    jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('service-key-abc') }));
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    const { createClient } = require('@supabase/supabase-js');
    const { getSupabase } = require('../../lib/supabase');
    getSupabase();
    expect(createClient).toHaveBeenCalledWith('https://test.supabase.co', 'service-key-abc');
  });
});

test('returns the same client instance on repeated calls (singleton)', () => {
  jest.isolateModules(() => {
    jest.mock('@supabase/supabase-js', () => ({ createClient: jest.fn().mockReturnValue({ from: jest.fn() }) }));
    jest.mock('../../lib/keychain', () => ({ getSecret: jest.fn().mockReturnValue('service-key-abc') }));
    process.env.SUPABASE_URL = 'https://test.supabase.co';
    const { createClient } = require('@supabase/supabase-js');
    const { getSupabase } = require('../../lib/supabase');
    const a = getSupabase();
    const b = getSupabase();
    expect(a).toBe(b);
    expect(createClient).toHaveBeenCalledTimes(1);
  });
});
