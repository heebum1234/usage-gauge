const { fetchUsage } = require('../src/usage-fetcher');

function printService(name, usage) {
  const parsed = usage && usage[name] ? usage[name] : null;
  const raw = usage && usage.raw ? usage.raw[name] : '';

  console.log(`\n[${name}] parsed`);
  console.log(JSON.stringify(parsed, null, 2));
  console.log(`\n[${name}] raw`);
  console.log(raw || '(no output captured)');
}

async function main() {
  const usage = await fetchUsage({ debug: true });
  console.log('[usage] result');
  console.log(JSON.stringify(
    {
      claude: usage.claude ? { pct: usage.claude.pct, resetInMs: usage.claude.resetInMs, plan: usage.claude.plan } : null,
      codex: usage.codex ? { pct: usage.codex.pct, resetInMs: usage.codex.resetInMs, plan: usage.codex.plan } : null,
      errors: usage.errors || {},
      fetchedAt: usage.fetchedAt,
    },
    null,
    2,
  ));

  printService('claude', usage);
  printService('codex', usage);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
