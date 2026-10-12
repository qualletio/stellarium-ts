const port = process.argv[2];
const response = await fetch(`http://127.0.0.1:${port}/v1/`);
process.exit(response.ok ? 0 : 1);
