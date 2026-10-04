"""Console remains available; joystick traffic has a separate USB data port."""
import usb_cdc
import usb_hid
import usb_midi

# Free USB endpoints before enabling the second CDC interface.
usb_hid.disable()
usb_midi.disable()
usb_cdc.enable(console=True, data=True)
