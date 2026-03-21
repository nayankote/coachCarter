const { execSync } = require('child_process');
jest.mock('child_process');

const { getSecret } = require('../../lib/keychain');

test('retrieves and trims secret from Keychain', () => {
  execSync.mockReturnValue(Buffer.from('mysecret\n'));
  expect(getSecret('coachcarter-garmin')).toBe('mysecret');
  expect(execSync).toHaveBeenCalledWith(
    'security find-generic-password -s "coachcarter-garmin" -w',
    { stdio: ['pipe', 'pipe', 'ignore'] }
  );
});

test('throws a clear error when secret not found', () => {
  execSync.mockImplementation(() => {
    throw new Error('SecKeychainSearchCopyNext: The specified item could not be found.');
  });
  expect(() => getSecret('nonexistent')).toThrow('Secret "nonexistent" not found');
});
