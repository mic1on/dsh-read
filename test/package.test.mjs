// Guards the package shape DSH itself relies on: the loader resolves the cordis
// entry by package name, and client-modules resolves the browser half through
// exports["./client"]. A typo in either is only visible at app launch, so it is
// checked here instead.

import assert from 'node:assert/strict'
import { readFileSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const root = new URL('../', import.meta.url)
const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'))

function exists(relativePath) {
  return statSync(fileURLToPath(new URL(relativePath, root)), { throwIfNoEntry: false }) !== undefined
}

function clientExportTarget() {
  const entry = manifest.exports['./client']
  return typeof entry === 'string' ? entry : entry.default
}

test('every path the package advertises actually exists', () => {
  const paths = [
    manifest.main,
    manifest.types,
    manifest.exports['.'].default,
    manifest.exports['.'].types,
    clientExportTarget(),
    manifest.exports['./cordis.patch.yml'],
    manifest.dsh.bundle.patch,
  ]
  for (const relativePath of paths) {
    assert.ok(exists(relativePath), `missing advertised file: ${relativePath}`)
  }
})

test('the shipped file list covers every advertised path', () => {
  for (const entry of manifest.files) {
    assert.ok(exists(entry), `files[] entry does not exist: ${entry}`)
  }
  // lib/ is published wholesale; make sure that is still true.
  assert.ok(manifest.files.includes('lib'))
})

test('the client half is declared for the web platform', () => {
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.client.immediately, undefined)
})

test('the browser half loads the conversation package it consumes', () => {
  // The bundle calls ctx.uiConversation, which only exists once this package's
  // client module is in the graph — dropping this entry fails at runtime, not at
  // build time.
  assert.ok(
    Array.isArray(manifest.dsh.client.inject) &&
      manifest.dsh.client.inject.includes('@deepseek-ai/dsh-client-ui-conversation'),
    'dsh.client.inject must list @deepseek-ai/dsh-client-ui-conversation',
  )
  const bundle = readFileSync(fileURLToPath(new URL(clientExportTarget(), root)), 'utf8')
  assert.match(bundle, /uiConversation/)
})

test('the cordis patch mounts this package by name', () => {
  const patch = readFileSync(fileURLToPath(new URL(manifest.dsh.bundle.patch, root)), 'utf8')
  assert.match(patch, /-\s*insert:/)
  assert.match(patch, new RegExp(`name:\\s*${manifest.name}\\b`))
  // The entry id must match the plugin name the browser half exports.
  assert.match(patch, new RegExp(`id:\\s*${manifest.name}\\b`))
})

test('the browser half registers under the same id it is mounted as', () => {
  const bundle = readFileSync(fileURLToPath(new URL(clientExportTarget(), root)), 'utf8')
  assert.match(bundle, new RegExp(`id:\\s*['"]${manifest.name}['"]`))
  assert.match(bundle, /window\.__ModuleLoader__\.load\(/)
})

test('the plugin entry exports a cordis name and an apply function', async () => {
  const plugin = await import(new URL(manifest.main, root).href)
  assert.equal(plugin.name, manifest.name)
  assert.equal(typeof plugin.apply, 'function')
  // webServer must not be a hard dependency: a headless profile would hang on it.
  assert.ok(!(plugin.inject ?? []).includes('webServer'))
})

// Reading `ctx.<service>` without declaring it throws at load time and takes the
// whole DSH composition down with it, so the declaration is checked statically.
const CONTEXT_BUILTINS = new Set(['get', 'inject', 'effect', 'on', 'off', 'provide', 'logger'])

test('every ctx.<service> the host half touches is declared in inject', async () => {
  const plugin = await import(new URL(manifest.main, root).href)
  const declared = new Set(plugin.inject ?? [])

  const sources = [
    readFileSync(fileURLToPath(new URL(manifest.main, root)), 'utf8'),
    readFileSync(fileURLToPath(new URL('lib/tool.mjs', root)), 'utf8'),
  ]

  const accessed = new Set()
  for (const source of sources) {
    for (const [, name] of source.matchAll(/\bctx\.([A-Za-z_$][\w$]*)/g)) accessed.add(name)
  }

  for (const name of accessed) {
    if (CONTEXT_BUILTINS.has(name)) continue
    assert.ok(declared.has(name), `ctx.${name} is accessed but missing from the plugin's inject`)
  }

  // And the declarations we do make must be the ones actually used.
  for (const name of declared) {
    assert.ok(accessed.has(name), `inject declares "${name}" but the host half never uses it`)
  }
})
