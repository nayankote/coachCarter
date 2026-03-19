// Stub — full implementation in Task 11
async function run(workoutId) {
  throw new Error(`analyze-workout not yet implemented for ${workoutId}`);
}

module.exports = { run };
if (require.main === module) run(process.argv[2]).catch(console.error);
