#!/usr/bin/env node
// Runs the desktop app with the web-ui, services and devices code from the sibling local
// repos (../web-ui, ../services, ../devices) instead of the published web bundle.
//
//   npm run dev:local                      build everything, then start the app
//   npm run dev:local -- --skip-build      start the app with the last local build
//   npm run dev:local -- --keep            keep using the local build on later plain starts
//   npm run dev:local -- --mock-zwift-play add a simulated Zwift Play (window.mockZwiftPlay in the page)
//   npm run dev:local -- --devtools        open the DevTools (inspector) with the app
//   other arguments are passed on to electron, e.g. --remote-debugging-port=9223
//
// See "Running with local web-ui / services / devices" in CLAUDE.md.

const { spawnSync, spawn } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const args = process.argv.slice(2)
const has = (flag) => args.includes(flag)
const OWN_FLAGS = ['--skip-build', '--keep', '--mock-zwift-play', '--devtools']
const electronArgs = args.filter(a => !OWN_FLAGS.includes(a))

const desktopDir = path.resolve(__dirname, '..')
const workspace = path.resolve(desktopDir, '..')
const webUiDir = path.join(workspace, 'web-ui')

// npm package name in web-ui's node_modules -> sibling repo
const LIBRARIES = [
    { pkg: 'incyclist-devices', repo: 'devices' },
    { pkg: 'incyclist-services', repo: 'services' },
]

const appDataDir = () => {
    switch (process.platform) {
        case 'darwin': return path.join(os.homedir(), 'Library', 'Application Support', 'Incyclist')
        case 'win32': return path.join(process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming'), 'Incyclist')
        default: return path.join(process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config'), 'Incyclist')
    }
}
const settingsFile = path.join(appDataDir(), 'settings.json')

const run = (cmd, cmdArgs, cwd) => {
    console.log(`> (${path.relative(workspace, cwd) || '.'}) ${cmd} ${cmdArgs.join(' ')}`)
    const res = spawnSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
    if (res.status !== 0) {
        console.error(`failed: ${cmd} ${cmdArgs.join(' ')} (in ${cwd})`)
        process.exit(res.status ?? 1)
    }
}

const build = () => {
    if (!fs.existsSync(path.join(webUiDir, 'node_modules')))
        run('npm', ['ci'], webUiDir)

    for (const { pkg, repo } of LIBRARIES) {
        const repoDir = path.join(workspace, repo)
        if (!fs.existsSync(path.join(repoDir, 'package.json'))) {
            console.log(`- ${repo}: no local repo, using the published ${pkg}`)
            continue
        }
        if (!fs.existsSync(path.join(repoDir, 'node_modules')))
            run('npm', ['ci'], repoDir)
        run('npm', ['run', 'build'], repoDir)

        // the production web-ui build bundles the copy in its node_modules - replace its lib
        const target = path.join(webUiDir, 'node_modules', pkg, 'lib')
        fs.rmSync(target, { recursive: true, force: true })
        fs.cpSync(path.join(repoDir, 'lib'), target, { recursive: true })
        console.log(`- ${repo}: local build copied into web-ui/node_modules/${pkg}`)
    }

    run('npm', ['run', 'build'], webUiDir)
}

const readSettings = () => JSON.parse(fs.readFileSync(settingsFile, 'utf-8'))
const writeSettings = (settings) => fs.writeFileSync(settingsFile, JSON.stringify(settings, null, 2))

// with `pageUrl` set, the app loads that page and skips its web bundle update check
const setPageUrl = (url) => {
    if (!fs.existsSync(settingsFile)) {
        console.error(`${settingsFile} not found - start the app normally once first`)
        process.exit(1)
    }
    const settings = readSettings()
    if (url) settings.pageUrl = url
    else delete settings.pageUrl
    writeSettings(settings)
}

if (!has('--skip-build'))
    build()

const indexHtml = path.join(webUiDir, 'build', 'index.html')
if (!fs.existsSync(indexHtml)) {
    console.error(`${indexHtml} not found - run without --skip-build first`)
    process.exit(1)
}
const query = has('--mock-zwift-play') ? '?mock=zwift-play' : ''
setPageUrl(`file://${indexHtml.split(path.sep).join('/')}${query}#ride`)

// DEBUG=1: renderer logs (devices and services included) go to stdout; the DevTools only on request
const env = { ...process.env, DEBUG: '1' }
if (!has('--devtools'))
    env.NO_DEVTOOLS = '1'

console.log('> starting Incyclist with the local build')
const electron = spawn('npx', ['electron', './', ...electronArgs], { cwd: desktopDir, env, stdio: 'inherit', shell: process.platform === 'win32' })

const restore = () => {
    if (has('--keep')) return
    try { setPageUrl(undefined); console.log('pageUrl removed - plain starts use the published web bundle again') }
    catch (err) { console.error('could not remove pageUrl:', err.message) }
}
electron.on('exit', (code) => { restore(); process.exit(code ?? 0) })
for (const signal of ['SIGINT', 'SIGTERM'])
    process.on(signal, () => electron.kill(signal))
