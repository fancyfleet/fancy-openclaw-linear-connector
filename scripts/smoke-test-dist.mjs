import { spawn } from 'child_process';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';
import os from 'os';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');

async function smokeTest() {
  console.log('Starting dist-boot smoke test...');

  const entryPoint = path.join(ROOT, 'dist', 'index.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-dist-smoke-'));
  const agentsFile = path.join(tmpDir, 'agents.json');
  const dataDir = path.join(tmpDir, 'data');

  fs.writeFileSync(agentsFile, JSON.stringify({
    agents: [{
      name: 'smoke-test-agent',
      linearUserId: 'u-smoke',
      openclawAgent: 'ai',
      accessToken: 'tok-smoke',
      host: 'local'
    }]
  }));

  const child = spawn('node', [entryPoint], {
    cwd: ROOT,
    env: {
      ...process.env,
      PORT: '0', // Let OS pick a random port
      NODE_ENV: 'production',
      ADMIN_SECRET: 'smoke-test-secret',
      LINEAR_CONNECTOR_ENCRYPTION_KEY: '0000000000000000000000000000000000000000000000000000000000000000',
      DATA_DIR: dataDir,
      AGENTS_FILE: agentsFile,
    }
  });

  let output = '';
  let errorOutput = '';

  child.stdout.on('data', (data) => {
    const str = data.toString();
    output += str;
    process.stdout.write(str);
  });

  child.stderr.on('data', (data) => {
    const str = data.toString();
    errorOutput += str;
    process.stderr.write(str);
  });

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => reject(new Error('TIMEOUT')), 10000);
  });

  const bootPromise = new Promise((resolve, reject) => {
    const checkInterval = setInterval(() => {
      if (`${output}\n${errorOutput}`.includes('listening on port')) {
        clearInterval(checkInterval);
        resolve('SUCCESS');
      }
    }, 500);

    child.on('exit', (code) => {
      clearInterval(checkInterval);
      if (code !== 0 && code !== null) {
        reject(new Error(`Process exited with code ${code}`));
      } else {
        // If it exited with 0 but we didn't see "listening", it's probably not what we want in a boot test
        // but for a module-load smoke test, exit 0 might be okay if it's just a module.
        // However, this app is a server.
        reject(new Error('Process exited unexpectedly'));
      }
    });

    child.on('error', (err) => {
      clearInterval(checkInterval);
      reject(err);
    });
  });

  try {
    await Promise.race([bootPromise, timeoutPromise]);
    console.log('\nSmoke test PASSED: Application booted successfully.');
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(0);
  } catch (err) {
    console.error(`\nSmoke test FAILED: ${err.message}`);
    if (errorOutput.includes('ReferenceError')) {
      console.error('Detected ReferenceError during bootstrap!');
    }
    child.kill();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    process.exit(1);
  }
}

smokeTest();
