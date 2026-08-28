# Installing a userplugin (like DeleteMyMessages) from source

Vencord plugins that live in a repo like this one are **not** installed by
dropping a file into your Discord folder — they only work if you clone
Vencord itself from source, copy the plugin into `src/userplugins/`, build
Vencord, and point your client at that build. This doc is the condensed,
"just tell me the commands" version of everything that can go wrong, based
on real trial and error.

There are two halves to this:
1. [Build Vencord from source with the plugin included](#1-build-vencord-from-source)
2. [Point your Discord client at your custom build](#2-point-your-client-at-the-build)

---

## 0. Prerequisites

- **Git**
- **Node.js ≥ 22** (`node -v`)
- **pnpm ≥ 9**, ideally installed via pnpm's own standalone installer so it
  can self-manage its version without fighting your OS package manager:
  ```sh
  curl -fsSL https://get.pnpm.io/install.sh | sh -
  ```
  Then reload your shell (`exec $SHELL -l` or open a new terminal) and
  confirm both work correctly:
  ```sh
  node -v   # v22 or higher
  pnpm -v
  ```

> **If you installed pnpm through your OS's package manager (pacman, apt,
> brew, etc.) and hit weird errors** like `ERR_PNPM_UNUSED_PATCH`,
> `pnpm setup` failing with permission errors, or `package.json` mysteriously
> turning into `{}` — uninstall that package and use the standalone
> installer above instead. Distro-packaged pnpm often can't manage its own
> version/runtime cleanly, which causes exactly these symptoms. See
> [Troubleshooting](#troubleshooting) below for more on this.

---

## 1. Build Vencord from source

```sh
git clone https://github.com/Vendicated/Vencord
cd Vencord
pnpm install --frozen-lockfile
```

Now add this plugin as a userplugin:

```sh
cd src/userplugins
git clone -b arena/01a04830-vencord-plugin --depth 1 https://github.com/Glockerz/Vencord-Plugin.git tmp-plugin-clone
cp -r tmp-plugin-clone/deleteMyMessages ./deleteMyMessages
rm -rf tmp-plugin-clone
cd ../..
```

(Swap the branch/plugin folder for whichever plugin(s) from this repo you
want — the pattern is always "copy the plugin's own folder into
`src/userplugins/<pluginName>`".)

Build:

```sh
pnpm build
```

You should see esbuild finish with output for `preload.js`, `patcher.js`,
`renderer.js`, `vencordDesktopMain.js`, `vencordDesktopPreload.js`, and
`vencordDesktopRenderer.js` in `dist/`. If it instead fails with
`Could not resolve "./userplugins/<name>"`, the plugin folder isn't where
esbuild expects it — re-check the `cp` step above.

**Verify the plugin actually made it into the build** (do this after every
rebuild if you're debugging — it's the fastest way to know if something
went wrong):

```sh
grep -c "DeleteMyMessages" dist/vencordDesktopRenderer.js
```
Should print `1` or higher. If it prints `0`, rebuild (`rm -rf dist &&
pnpm build`) and check again before touching your client — don't waste time
debugging the client if the plugin isn't even in the freshly built file.

### Rebuilding after code changes

Any time you edit the plugin (or pull updates), just rerun:

```sh
pnpm build
```

or use watch mode to auto-rebuild on save:

```sh
pnpm build --watch
```

---

## 2. Point your client at the build

### Vesktop (recommended, easiest)

1. **If you're on Linux using the Flatpak build of Vesktop**, grant it
   filesystem access to your Vencord folder first (Flatpak sandboxes
   everything by default):
   ```sh
   flatpak override dev.vencord.Vesktop --filesystem="$HOME/Documents/Vencord"
   ```
   (adjust the path to wherever you actually cloned Vencord)

2. **Important workaround for a Vesktop bug**: Vesktop checks for a
   `package.json` file directly inside your `dist` folder to decide whether
   your custom build is "valid." Vencord's `pnpm build` does **not** create
   one there, so without this file Vesktop will think your build is broken,
   silently delete your custom `vencordDesktop*.js` files, and replace them
   with the official downloaded ones — wiping out your plugin every time you
   launch it. Always run this after every `pnpm build`:
   ```sh
   echo '{}' > dist/package.json
   ```
   To avoid forgetting this, add a shell function/alias that does both at
   once, e.g. in `~/.bashrc` / `~/.config/fish/config.fish`:
   ```sh
   # bash/zsh
   vbuild() { (cd ~/Documents/Vencord && rm -rf dist && pnpm build && echo '{}' > dist/package.json); }
   ```
   ```fish
   # fish
   function vbuild
       cd ~/Documents/Vencord
       rm -rf dist
       pnpm build
       echo '{}' > dist/package.json
   end
   ```

3. Open Vesktop → **Settings → Vesktop Settings → Vencord Location** →
   **Change** → select the `dist` folder inside your cloned Vencord repo.

4. **Fully quit and relaunch Vesktop** (not just close the window — Vesktop
   minimizes to tray by default, which won't reload the build). On Flatpak:
   ```sh
   flatpak kill dev.vencord.Vesktop
   flatpak run dev.vencord.Vesktop
   ```

5. Go to **Settings → Plugins**, search for the plugin name, and enable it.

### Discord Desktop (official client + Vencord injector)

```sh
pnpm inject
```
Follow the prompts (select your Discord install), then fully restart
Discord.

---

## Updating just the plugin

The plugin folder is **copied** into your Vencord checkout, so Vencord will
never pull plugin updates for you — you re-copy the folder and rebuild. One
block does the whole thing (adjust the Vencord path if yours differs):

```sh
cd ~/Documents/Vencord
git clone -b arena/01a04830-vencord-plugin --depth 1 https://github.com/Glockerz/Vencord-Plugin.git /tmp/vp-update
rm -rf src/userplugins/deleteMyMessages
cp -r /tmp/vp-update/deleteMyMessages src/userplugins/deleteMyMessages
rm -rf /tmp/vp-update
pnpm build
echo '{}' > dist/package.json                                   # Vesktop workaround, see above
grep -c "DeleteMyMessages" dist/vencordDesktopRenderer.js       # must print 1 or more
```

Then fully quit and relaunch your client (see the next section for the
CachyOS-specific commands).

Handy as a shell function so you never forget the `dist/package.json` step:

```sh
# bash/zsh  (~/.bashrc / ~/.zshrc)
vupdate() {
    (cd ~/Documents/Vencord \
     && git clone -b arena/01a04830-vencord-plugin --depth 1 https://github.com/Glockerz/Vencord-Plugin.git /tmp/vp-update \
     && rm -rf src/userplugins/deleteMyMessages \
     && cp -r /tmp/vp-update/deleteMyMessages src/userplugins/deleteMyMessages \
     && rm -rf /tmp/vp-update \
     && pnpm build \
     && echo '{}' > dist/package.json \
     && grep -c "DeleteMyMessages" dist/vencordDesktopRenderer.js)
}
```
```fish
# fish  (~/.config/fish/config.fish)
function vupdate
    cd ~/Documents/Vencord
    git clone -b arena/01a04830-vencord-plugin --depth 1 https://github.com/Glockerz/Vencord-Plugin.git /tmp/vp-update
    rm -rf src/userplugins/deleteMyMessages
    cp -r /tmp/vp-update/deleteMyMessages src/userplugins/deleteMyMessages
    rm -rf /tmp/vp-update
    pnpm build
    echo '{}' > dist/package.json
    grep -c "DeleteMyMessages" dist/vencordDesktopRenderer.js
end
```

> `pnpm build` alone is enough after this — no need for `rm -rf dist` unless
> the build output looks stale.

### Restarting the client on CachyOS

- **Vesktop from the repos/AUR** (`paru -S vesktop`): quit it properly first —
  it hides in the tray, and a window close does not reload the build:
  ```sh
  pkill -f vesktop
  vesktop &>/dev/null &
  ```
- **Vesktop Flatpak**:
  ```sh
  flatpak kill dev.vencord.Vesktop
  flatpak run dev.vencord.Vesktop
  ```
- **Official Discord + `pnpm inject`**: fully quit Discord (tray included)
  and start it again; re-run `pnpm inject` only if a Discord update replaced
  the injected files.

### Updating everything else on CachyOS

CachyOS ships `paru`, which updates both the repo packages and your AUR
packages in one go (no `sudo` needed — it asks for your password itself):

```sh
paru              # same as: paru -Syu
```

Optional extras:
```sh
paru -S vesktop                       # update the Vesktop app itself (repos/AUR install)
flatpak update dev.vencord.Vesktop    # ...or the Flatpak, if that's how you installed it
```

Updating Vesktop or Discord does **not** touch your custom Vencord build —
but a Discord client update can undo `pnpm inject`, and Vesktop can wipe
`dist/` if `dist/package.json` is missing (see above). When in doubt, re-run
`vupdate` and check with:

```sh
grep -c "DeleteMyMessages" ~/Documents/Vencord/dist/vencordDesktopRenderer.js
```

## Updating later

Once you're set up with a custom build, **Vesktop will not auto-update
Vencord for you anymore** — it just keeps using whatever's in your `dist`
folder. To pull in upstream Vencord changes, rebuild manually whenever you
want:

```sh
cd ~/Documents/Vencord
git pull
pnpm install
pnpm build
echo '{}' > dist/package.json
```
Then fully restart Vesktop (or your `vbuild` shell function from above, if
you set it up — just add `git pull` at the top of it).

Vesktop **itself** (the app) still auto-updates normally through its own
updater/Flatpak — that's unrelated to this and unaffected either way.

> **Don't use Vesktop's "Force Update Vencord" menu option** (tray icon
> right-click, or the app menu) while running a custom build with plugins —
> it downloads the official prebuilt Vencord files directly into your
> `dist` folder, overwriting your build and removing any custom plugins.
> If you click it by accident, just rerun `pnpm build` to restore your
> custom build.

---

## Verifying the plugin loaded

Open DevTools in your client (`Ctrl+Shift+I`), go to the Console tab, and
run:

```js
Vencord.Plugins.plugins["DeleteMyMessages"]
```

- Returns a plugin object → it's loaded correctly, just check Settings →
  Plugins if you don't see it in the UI (search bar, scroll position, etc).
- Returns `undefined` → it did not load. Re-check that
  `grep -c "DeleteMyMessages" dist/vencordDesktopRenderer.js` (or
  `dist/renderer.js` for Discord Desktop) returns nonzero for the file your
  client is *actually* reading, then work backwards from there using the
  troubleshooting section below.

---

## Troubleshooting

**`ERR_PNPM_UNUSED_PATCH` when running `pnpm install`/`pnpm build`**
Usually caused by a pnpm-managed Node.js runtime getting mixed up with your
system Node (this can happen if you ever ran `pnpm env use`, which manages
*Node* versions, not pnpm's own version — easy command to confuse). Check:
```sh
node -v
which node
```
If `node` resolves to somewhere under `~/.local/share/pnpm/...` and shows an
unexpectedly old/new version, remove pnpm's Node shim and use your system
Node instead:
```sh
rm -f $PNPM_HOME/bin/node
exec $SHELL -l
node -v   # should now show your system Node
```

**`package.json` in the Vencord repo keeps turning into `{}`**
This is pnpm's own `packageManager`-field auto-relaunch feature misbehaving
on some setups (particularly distro-packaged pnpm on Linux). Restore it and
disable version auto-switching for pnpm operations inside the repo:
```sh
git checkout -- package.json
```
If it keeps happening, switch to pnpm's standalone installer (see
[Prerequisites](#0-prerequisites)) instead of a distro package.

**Vencord Location build seems to randomly revert / plugin disappears
after every Vesktop restart**
See the `dist/package.json` workaround under
[Vesktop](#vesktop-recommended-easiest) above — this is the #1 cause.

**Build fails with `Could not resolve "./userplugins/<name>"`**
The plugin folder doesn't exist at `src/userplugins/<name>/` with an
`index.ts`/`index.tsx` inside it. Re-check the clone/copy step.

**Everything crashes on startup with errors like `Cannot read properties of
undefined (reading 'Webpack')` right after switching to a custom build**
This usually means Node.js itself got swapped to an incompatible version
mid-troubleshooting (see the `ERR_PNPM_UNUSED_PATCH` fix above), not an
actual problem with the plugin or Vencord/Vesktop version mismatch. Confirm
`node -v` is a normal, current LTS version, then do a full clean rebuild.
