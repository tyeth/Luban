"""Run with python examples/usb-pendant/test_controller.py; no hardware motion."""
import sys
import pathlib
import unittest

sys.path.insert(0, str(pathlib.Path(__file__).parent / "firmware"))
from controller import Controller, normalize, deadzone


class ControllerTests(unittest.TestCase):
    def test_calibration_deadzone_and_inversion(self):
        self.assertEqual(deadzone(0.05), 0)
        self.assertEqual(normalize(0), -1)
        self.assertEqual(normalize(65535), 1)
        self.assertEqual(normalize(0, inverted=True), 1)
        self.assertEqual(normalize(20000, center=20000), 0)
        with self.assertRaises(ValueError):
            normalize(30000, center=0, minimum=0, maximum=0)

    def test_boot_and_disconnect_need_neutral_with_deadman_released(self):
        c = Controller()
        args = (1, 0, 0, False, True, False, 1, 0.05, True)
        self.assertFalse(c.update(*args)["deadman"])
        c.update(0, 0, 0, False, False, False, 2, 0.05, True)
        self.assertTrue(c.update(*args)["deadman"])
        self.assertFalse(c.update(1, 0, 0, False, True, False, 3, 0.05, False)["deadman"])
        self.assertFalse(c.update(*args)["deadman"])

    def test_button_debounce_mode_switch_resets_feed_and_blocks_held_twist(self):
        c = Controller()
        c.update(0, 0, 0, False, False, False, 0, 0.05, True)
        c.update(0, 0, 1, False, False, False, 1, 0.1, True)
        self.assertGreater(c.feed, 60)
        c.update(0, 0, 1, True, True, False, 2, 0.05, True)
        self.assertEqual(c.mode, "feed")
        p = c.update(0, 0, 1, True, True, False, 2.04, 0.04, True)
        self.assertEqual(c.mode, "z")
        self.assertEqual(c.feed, 60)
        self.assertEqual(p["z"], 0)
        c.update(0, 0, 0, False, False, False, 3, 0.05, True)
        c.update(0, 0, 0, False, False, False, 3.04, 0.04, True)
        self.assertEqual(c.update(0, 0, -1, False, True, False, 4, 0.05, True)["z"], -1)
        c.update(0, 0, 0, True, False, False, 5, 0.05, True)
        c.update(0, 0, 0, True, False, False, 5.04, 0.04, True)
        self.assertEqual(c.mode, "feed")
        self.assertEqual(c.feed, 60)

    def test_feed_caps_and_stop_never_moves(self):
        c = Controller()
        c.update(0, 0, 0, False, False, False, 0, 0.01, True)
        for i in range(50):
            c.update(0, 0, 1, False, True, False, i + 1, 0.1, True)
        self.assertEqual(c.feed, 600)
        p = c.update(1, 1, 1, False, True, True, 60, 0.1, True)
        self.assertEqual(p["feed"], 60)
        self.assertFalse(p["deadman"])
        self.assertEqual((p["x"], p["y"], p["z"]), (0, 0, 0))


if __name__ == "__main__":
    unittest.main()
