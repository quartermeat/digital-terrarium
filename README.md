# Digital Terrarium

An aquarium of electronic life rendered over the selected KDE desktop
wallpaper. It runs as a desktop-level Electron scene beneath normal windows.

## Run

```bash
npm install
npm start
```

The Go bridge reads the selected wallpaper from KDE configuration and exposes
it at `/api/wallpaper`, supplies a reproducible population at `/api/habitat`,
and reports CPU and memory readings. Creature movement uses WebGPU when
available, then WebGL2 transform feedback, with a JavaScript fallback.

Hover over a creature or circuit root for a contextual readout. Click the
scene to release energy packets. `Ctrl+Alt+Q` quits the terrarium.

For browser preview, run `npm run serve` and open
`http://127.0.0.1:8090/terrarium.html`. Browser preview cannot reproduce the
desktop wallpaper layer.
