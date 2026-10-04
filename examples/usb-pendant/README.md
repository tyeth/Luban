# Feather USB joystick and DRO

Adafruit Feather ESP32-S3 **Reverse TFT**, board ID
`adafruit_feather_esp32s3_reverse_tft`. User-selected firmware: CircuitPython
**11.0.0-alpha.1 UF2**, with **20261003 11.x-mpy** Adafruit library bundle.
The controller uses USB, so the existing Wi-Fi settings are preserved but unused.

## Backup and recreation

The original USB device was backed up **before any update** to
`backups/2026-10-04-before-update/CIRCUITPY/`, beside this README in the local
controller project. `manifest.json` records all 161 copied files and their
SHA-256 hashes; every source/copy pair was verified. `settings.toml` contains
private configuration and stays local. Old firmware was CircuitPython 9.2.1;
`original-circuitpython-9.2.1.uf2` and `INFO_UF2.TXT` preserve its application
firmware and original TinyUF2 0.20.1 identity. The backup excludes Windows
`System Volume Information`. Do not publish the backup or private settings.

The local `firmware/` directory holds downloaded firmware, bootloader packages
and library bundles. The new `device/` directory is a complete installation
image including only the required latest display libraries and private
settings; `device-manifest.json` records its hashes. Code also lives in the
Luban repository under `examples/usb-pendant/firmware/`. Use that repository's
`deploy.py` to stage a fresh installation, or the local `deploy.py --device
device --drive D:/` to recopy a previously staged image.

Official downloads:

- [CircuitPython 11 board UF2](https://circuitpython.org/board/adafruit_feather_esp32s3_reverse_tft/)
- [Adafruit library bundle](https://github.com/adafruit/Adafruit_CircuitPython_Bundle/releases/tag/20261003)
- [TinyUF2 update instructions](https://learn.adafruit.com/esp32-s3-reverse-tft-feather/update-tinyuf2-bootloader-for-circuitpython-10-4mb-boards-only)

Installation uses **UF2 copying only**. Double-press RESET to mount FTHRS3BOOT,
then copy the selected CircuitPython 11 UF2. Verify `CIRCUITPY/boot_out.txt`
reports CircuitPython 11 and the exact board ID before copying device files.
This 4 MB board needs TinyUF2 0.33.0 or later and the larger application
partition layout. A bootloader self-update can retain the old partition table;
if a newer UF2 returns to FTHRS3BOOT, check the layout rather than claiming
installation succeeded. The bootloader update can erase CIRCUITPY, so keep
the verified backup. No esptool write is part of this workflow.

From the Luban repository, PowerShell:

```powershell
python examples/usb-pendant/deploy.py --uf2 C:/dev/python/circuitpython/3dof-luban-controller/firmware/circuitpython-11.0.0-alpha.1.uf2 --drive D:/
# After CIRCUITPY reappears and boot_out.txt confirms CircuitPython 11:
python examples/usb-pendant/deploy.py --project C:/dev/python/circuitpython/3dof-luban-controller --bundle C:/dev/python/circuitpython/3dof-luban-controller/firmware/adafruit-circuitpython-bundle-11.x-mpy-20261003.zip --settings C:/dev/python/circuitpython/3dof-luban-controller/backups/2026-10-04-before-update/CIRCUITPY/settings.toml --drive D:/
```

Press RESET once after copying `boot.py`. USB exposes console and data serial
ports; select **data**, generally the second port. HID and MIDI are disabled to
free USB endpoints. The console is for diagnostics, never the jogging stream.
To restore the old application, copy its saved UF2 to FTHRS3BOOT and restore
the old CIRCUITPY tree. The new TinyUF2 layout supports CircuitPython 9.1+
but the original 9.x compiled libraries must be restored with the old code.

## Wiring and controls

| Input | Pin | Behaviour |
|---|---|---|
| Joystick X | D6 | X jog; inverted as in the original program |
| Joystick Y | D5 | Y jog |
| Twist | D9 | Feed adjustment or Z jog |
| Joystick button | D10, pull-down | Switch twist mode; always reset feed to 60 mm/min |
| Feather D1 | Built-in, pull-down | Hold to jog; release to stop requesting moves |
| Feather D2 | Built-in, pull-down | Stop and disarm |
| Feather D0 | Built-in, pull-up | Switch DRO machine/work frame |

Feed mode starts at 60 mm/min; twist increases/decreases it within 60–600.
Z mode uses the reset slow feed. Startup, a mode change, USB loss, a new arm
or STOP requires all axes centered and D1 released. Button edges are debounced.
X/Y remain available in both twist modes. No Wi-Fi, homing, origin writes,
spindle commands or raw G-code come from this controller.

Optional calibration keys in `settings.toml` are
`JOYSTICK_{X,Y,TWIST}_{CENTER,MIN,MAX,INVERT}` and `JOYSTICK_DEADZONE`.
Defaults are centre 32768, min 0, max 65535, 12% deadzone, X inverted.
Set these from actual released-centre and full-travel ADC readings; do not
automatically treat an off-centre boot position as neutral. `settings.example.toml`
contains public examples. Invalid calibration stops the firmware with a console
error. Calibration and direction need a physical check before operator use.

## Luban operation

Install/build the PR version of this Luban fork, enable its MCP server, and
connect the machine in Luban. Open <http://127.0.0.1:40889/pendant>. Connect
the Feather data port. Review the machine-coordinate XYZ envelope and confirm
the complete volume is clear for the fitted tool. Then click **Arm**. This
operator page is the session's decision point; no MCP tool can arm a pendant.

The session lasts at most 10 minutes, spans at most 100 mm per axis, and defaults
to ±5 mm within known travel. This is direct, supervised manual control:
the operator approves the entire local corridor, including its Z range, and
holds D1 for each movement. It does not reuse or broaden an AI job approval.
Known obstacles and tool-length clearances still refuse the envelope. The
usual agent motion-floor rules and staged-job workflow remain in force for AI
operations. Pendant control requires homed, idle, coherent fresh position,
toolhead off and no safety alarm or active job. A reconnect invalidates the arm.

Only one move is in flight. Each move is at most 0.5 mm in vector length and
uses the existing machine-frame settled-motion engine and contact/crash
tripwire. USB samples replace intent rather than queueing moves. USB silence
over 300 ms, browser silence over 2 seconds, STOP, expiry, invalid input or a
motion error disarms. The browser must remain visible. An already accepted
segment can finish after release/STOP; use the machine's physical emergency
stop for immediate stopping. A stopped/error session holds its position and
does not invent a retreat or any extra motion.

MCP mutations are excluded while the pendant owns control, and a pending MCP
operation prevents arming. Read-only `get_*`, `list_*`, `validate_*` and
`stop_gcode_job` remain available; stop also disarms. Manual control is
loopback-only even when MCP LAN access is enabled. Operator POSTs require a
page token, matching origin, and a loopback Host. The page cannot be framed.
The operator should not jog simultaneously using the touchscreen or other UI.

The TFT shows reported machine or work XYZ, mode and feed. It blanks stale,
disconnected or unreliable DRO data instead of displaying a locally integrated
position as a measurement. USB DRO updates do not make the machine's 2-second
heartbeat faster. Verify direction, calibration, stop/reconnect and a tiny
reviewed movement with the operator before treating the system as commissioned.

## Wire protocol and checks

USB data uses newline-delimited JSON at nominal 115200 baud. Input has
`v:1`, increasing `seq`, normalized `x,y,z`, `mode:feed|z`, `feed:60..600`,
and booleans `ready`, `deadman`, `stop`. Feed mode must send Z=0. Luban replies
with `type:dro`, `armed`, `neutral`, `machine`, `work`, `reliability`, `age_ms`,
`warnings` and an operator message. The board has no authority without the
operator's armed session and fresh DRO reply.

```powershell
python examples/usb-pendant/test_controller.py
npm run test:mcp
npm run typecheck:mcp
```

These tests use simulated input and do not move hardware. Hardware firmware
version, serial enumeration and real display startup must also be verified.
