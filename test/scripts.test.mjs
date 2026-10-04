import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { routerIlkSifreAl } from '../scripts/termux/9router-password.mjs';

const kok = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const durumBetigi = path.join(kok, 'scripts/termux/durum.sh');
const bashYok = process.platform === 'win32' ? 'bash betikleri Windows üzerinde bulunmaz' : false;

test('9router: ilk parola kriptografik olarak üretilir, kalıcıdır ve dosya izinleri kısıtlıdır', () => {
  const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-9router-parola-'));
  try {
    const sifreDosyasi = path.join(gecici, '9router.initial-password');
    const sifre = routerIlkSifreAl({ asistanHome: gecici });
    assert.match(sifre, /^[a-f0-9]{64}$/);
    assert.equal(routerIlkSifreAl({ asistanHome: gecici, ilkSifre: 'baska-parola' }), sifre);
    assert.equal(fs.readFileSync(sifreDosyasi, 'utf8'), `${sifre}\n`);
    if (process.platform !== 'win32') assert.equal(fs.statSync(sifreDosyasi).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(gecici, { recursive: true, force: true });
  }
});

test('9router: kullanıcı parolası yalnız ilk başlatmada kaydedilir', () => {
  const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-9router-parola-'));
  try {
    assert.equal(routerIlkSifreAl({ asistanHome: gecici, ilkSifre: 'kullanici-parolasi' }), 'kullanici-parolasi');
    assert.equal(routerIlkSifreAl({ asistanHome: gecici, ilkSifre: 'sonradan-degistirilen-env' }), 'kullanici-parolasi');
    if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(gecici, '9router.initial-password')).mode & 0o777, 0o600);
  } finally {
    fs.rmSync(gecici, { recursive: true, force: true });
  }
});

function durumCalistir(tlsDosyalari, tunnelUrl = '') {
  const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-durum-test-'));
  const prefix = path.join(gecici, 'prefix');
  const home = path.join(gecici, 'home');
  const asistHome = path.join(home, '.asistan');
  const bin = path.join(prefix, 'bin');
  const tlsDizini = path.join(asistHome, 'tls');
  const iz = path.join(gecici, 'curl.log');
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  if (tlsDosyalari.length) fs.mkdirSync(tlsDizini, { recursive: true });
  for (const ad of tlsDosyalari) fs.writeFileSync(path.join(tlsDizini, ad), 'test');

  const sahteCurl = path.join(bin, 'curl');
  fs.writeFileSync(sahteCurl, `#!/usr/bin/env bash
set -u
printf 'CALL:' >> "$CURL_LOG"
for arg in "$@"; do printf ' <%s>' "$arg" >> "$CURL_LOG"; done
printf '\\n' >> "$CURL_LOG"
URL=''
for arg in "$@"; do
  case "$arg" in http://*|https://*) URL="$arg";; esac
done
case "$URL" in
  *:20128/*) printf '200' ;;
  */saglik) printf '{"durum":"yasiyor"}' ;;
  */api/durum)
    if [[ "$*" == *'Authorization: Bearer test-token'* ]]; then printf '{"asistan":"Aspasia"}'; else printf '{"hata":"yetkisiz"}'; fi
    ;;
esac
`);
  fs.chmodSync(sahteCurl, 0o755);

  const sonuc = spawnSync('bash', [durumBetigi], {
    cwd: kok,
    encoding: 'utf8',
    timeout: 10_000,
    env: {
      ...process.env,
      PREFIX: prefix,
      TERMUX_HOME: home,
      ASISTAN_HOME: asistHome,
      BEYIN_TOKEN: 'test-token',
      BEYIN_PORT: '20131',
      BEDEN_PORT: '20130',
      CURL_LOG: iz,
      CLOUDFLARED_PUBLIC_URL: tunnelUrl,
    },
  });

  const trace = fs.existsSync(iz) ? fs.readFileSync(iz, 'utf8') : '';
  return { sonuc, trace, temizle: () => fs.rmSync(gecici, { recursive: true, force: true }) };
}

for (const { ad, tlsDosyalari, sema, tlsSecenegi } of [
  { ad: 'TLS kapalıyken HTTP sağlık kontrolü yapar', tlsDosyalari: [], sema: 'http', tlsSecenegi: false },
  { ad: 'TLS sertifikası ve anahtarı varken HTTPS ve -k kullanır', tlsDosyalari: ['cert.pem', 'key.pem'], sema: 'https', tlsSecenegi: true },
  { ad: 'eksik TLS dosyasında sunucuyla aynı şekilde HTTP kullanır', tlsDosyalari: ['cert.pem'], sema: 'http', tlsSecenegi: false },
]) {
  test(`durum.sh: ${ad}`, { skip: bashYok }, () => {
    const { sonuc, trace, temizle } = durumCalistir(tlsDosyalari);
    try {
      assert.equal(sonuc.status, 0, sonuc.stderr);
      assert.match(sonuc.stdout, /beyin\s+: ayakta/);
      assert.match(trace, new RegExp(`${sema}://127\\.0\\.0\\.1:20131/api/durum`));
      assert.match(trace, /Authorization: Bearer test-token/);
      assert.doesNotMatch(trace, /api\/durum\?token=/);
      assert.doesNotMatch(sonuc.stdout, /test-token/);
      assert.match(sonuc.stdout, new RegExp(`${sema}://[^\\s]+:20131/`));
      assert.equal(trace.includes(' <-k>'), tlsSecenegi);
    } finally {
      temizle();
    }
  });
}

test('durum.sh: tünel adresinden URL kullanıcı bilgisi, query ve fragment temizlenir', { skip: bashYok }, () => {
  const { sonuc, temizle } = durumCalistir([], 'https://tunnel-user:tunnel-pass@panel.example.test/panel?token=tunnel-query-secret#fragment-secret');
  try {
    assert.equal(sonuc.status, 0, sonuc.stderr);
    assert.match(sonuc.stdout, /https:\/\/panel\.example\.test\/panel\//);
    assert.doesNotMatch(sonuc.stdout, /tunnel-user|tunnel-pass|tunnel-query-secret|fragment-secret/);
  } finally {
    temizle();
  }
});

const bootBetigi = path.join(kok, 'scripts/termux/boot-kur.sh');

test('boot-kur.sh: üretilen hook ortam değişkenlerini boot anına bırakır ve sözdizimi geçerlidir', { skip: bashYok }, () => {
  const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-boot-test-'));
  const repo = path.join(gecici, 'repo');
  const home = path.join(gecici, 'home');
  const state = path.join(gecici, 'state');
  const copiedScript = path.join(repo, 'scripts/termux/boot-kur.sh');
  fs.mkdirSync(path.dirname(copiedScript), { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(bootBetigi, copiedScript);

  try {
    const sonuc = spawnSync('bash', [copiedScript], {
      cwd: repo,
      encoding: 'utf8',
      timeout: 10_000,
      env: { ...process.env, PREFIX: path.join(gecici, 'prefix'), TERMUX_HOME: home, ASISTAN_HOME: state },
    });
    assert.equal(sonuc.status, 0, sonuc.stderr);
    const hook = path.join(home, '.termux/boot/asistan.sh');
    const kaynak = fs.readFileSync(hook, 'utf8');
    assert.match(kaynak, /export PREFIX="\$\{PREFIX:-\/data\/data\/com\.termux\/files\/usr\}"/);
    assert.match(kaynak, /export HOME="\$\{TERMUX_HOME:-\/data\/data\/com\.termux\/files\/home\}"/);
    assert.match(kaynak, /export ASISTAN_HOME="\$\{ASISTAN_HOME:-\$HOME\/\.asistan\}"/);
    assert.match(kaynak, /source "\$REPO_DIR\/.env"/);
    assert.match(kaynak, /boot\.log/);
    assert.ok(fs.statSync(hook).mode & 0o111, 'üretilen hook çalıştırılabilir olmalı');
    const syntax = spawnSync('bash', ['-n', hook], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(syntax.status, 0, syntax.stderr);
  } finally {
    fs.rmSync(gecici, { recursive: true, force: true });
  }
});

function baslatCalistir({ enable, llmUrl = 'http://127.0.0.1:20128/v1', aramaUrl = '' }) {
  const gecici = fs.mkdtempSync(path.join(os.tmpdir(), 'asistan-baslat-test-'));
  const repo = path.join(gecici, 'repo');
  const termux = path.join(repo, 'scripts/termux');
  const home = path.join(gecici, 'home');
  const state = path.join(gecici, 'state');
  const prefix = path.join(gecici, 'prefix');
  const bin = path.join(prefix, 'bin');
  const calls = path.join(gecici, 'commands.log');
  const copiedScript = path.join(termux, 'baslat.sh');
  fs.mkdirSync(termux, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  fs.mkdirSync(home, { recursive: true });
  fs.copyFileSync(path.join(kok, 'scripts/termux/baslat.sh'), copiedScript);
  for (const ad of ['servis.sh', '9router-servis.sh', 'durum.sh', 'tunel.sh']) fs.writeFileSync(path.join(termux, ad), '#!/bin/sh\nexit 0\n');

  const stub = (ad, content = '#!/bin/sh\nexit 0\n') => {
    const target = path.join(bin, ad);
    fs.writeFileSync(target, content);
    fs.chmodSync(target, 0o755);
  };
  stub('bash', '#!/bin/sh\nprintf "%s\\n" "$*" >> "$COMMAND_LOG"\nexit 0\n');
  stub('sleep');
  stub('termux-wake-lock');
  stub('sshd');
  stub('9router');
  stub('pgrep', '#!/bin/sh\nexit 1\n');

  const env = {
    ...process.env,
    PREFIX: prefix,
    TERMUX_HOME: home,
    ASISTAN_HOME: state,
    COMMAND_LOG: calls,
    LLM_BASE_URL: llmUrl,
    ARAMA_LLM_BASE_URL: aramaUrl,
    ENABLE_9REMOTE: '0',
    CLOUDFLARED_PUBLIC_URL: '',
  };
  if (enable === undefined) delete env.ENABLE_9ROUTER;
  else env.ENABLE_9ROUTER = enable;

  const sonuc = spawnSync('/bin/bash', [copiedScript], { cwd: repo, encoding: 'utf8', timeout: 10_000, env });
  const cagrilar = fs.existsSync(calls) ? fs.readFileSync(calls, 'utf8') : '';
  return { sonuc, cagrilar, temizle: () => fs.rmSync(gecici, { recursive: true, force: true }) };
}

test('baslat.sh: varsayılan ENABLE_9ROUTER=1 ile yerel 9router başlar', { skip: bashYok }, () => {
  const { sonuc, cagrilar, temizle } = baslatCalistir({});
  try {
    assert.equal(sonuc.status, 0, sonuc.stderr);
    assert.match(sonuc.stdout, /9router başlatıldı/);
  } finally {
    temizle();
  }
});

test('baslat.sh: doğrudan endpoint ENABLE_9ROUTER=0 olmadan reddedilir', { skip: bashYok }, () => {
  const { sonuc, temizle } = baslatCalistir({ enable: '1', llmUrl: 'https://user:shell-pass@api.groq.com/openai/v1?token=shell-query-secret' });
  try {
    assert.equal(sonuc.status, 1);
    assert.match(sonuc.stderr, /ENABLE_9ROUTER=0/);
    assert.doesNotMatch(sonuc.stderr, /user|shell-pass|shell-query-secret/);
  } finally {
    temizle();
  }
});

test('baslat.sh: ENABLE_9ROUTER=0 doğrudan sağlayıcı modunda 9router\'ı atlar', { skip: bashYok }, () => {
  const { sonuc, cagrilar, temizle } = baslatCalistir({ enable: '0', llmUrl: 'https://api.groq.com/openai/v1' });
  try {
    assert.equal(sonuc.status, 0, sonuc.stderr);
    assert.match(sonuc.stdout, /9router atlandı/);
    assert.doesNotMatch(cagrilar, /servis\.sh 9router bash .*9router-servis\.sh/);
  } finally {
    temizle();
  }
});
