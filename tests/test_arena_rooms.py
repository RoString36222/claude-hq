"""Tests for the Arena rooms proxy layer in dashboard.py and arena.py.

Stdlib only (unittest). Run with:
    python3 -m unittest discover -s tests
"""
import json
import os
import sys
import unittest

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import arena      # noqa: E402
import dashboard  # noqa: E402


class RoomIdValidation(unittest.TestCase):
    """arena.ROOM_ID_RE and arena._valid_room_id."""

    def test_valid_room_ids(self):
        self.assertTrue(arena._valid_room_id("r_ABCDEFGHIJKLMNOPQRSTUv"))
        self.assertTrue(arena._valid_room_id("r_0123456789abcdef_ghi-k"))

    def test_invalid_room_ids(self):
        self.assertFalse(arena._valid_room_id(""))
        self.assertFalse(arena._valid_room_id("lobby"))
        self.assertFalse(arena._valid_room_id("r_short"))
        self.assertFalse(arena._valid_room_id("r_ABCDEFGHIJKLMNOPQRSTUv!"))  # 23 chars after r_
        self.assertFalse(arena._valid_room_id("R_ABCDEFGHIJKLMNOPQRSTUv"))  # uppercase R
        self.assertFalse(arena._valid_room_id(123))
        self.assertFalse(arena._valid_room_id(None))


class UserIdValidation(unittest.TestCase):
    """arena._valid_user_id."""

    def test_valid_uuid(self):
        self.assertTrue(arena._valid_user_id("01234567-89ab-cdef-0123-456789abcdef"))

    def test_invalid_uuids(self):
        self.assertFalse(arena._valid_user_id(""))
        self.assertFalse(arena._valid_user_id("not-a-uuid"))
        self.assertFalse(arena._valid_user_id("01234567-89AB-CDEF-0123-456789ABCDEF"))  # uppercase
        self.assertFalse(arena._valid_user_id(None))


class RoomBodyError(unittest.TestCase):
    """dashboard._room_body_error rejects bad input before I/O."""

    def test_create_requires_name_and_password(self):
        err = dashboard._room_body_error("/api/arena/rooms/create", {})
        self.assertIn("name", err)

        err = dashboard._room_body_error("/api/arena/rooms/create", {"name": "hi"})
        self.assertIn("password", err)

    def test_create_validates_name_length(self):
        err = dashboard._room_body_error("/api/arena/rooms/create",
                                         {"name": "a" * 201, "password": "secret123"})
        self.assertIn("name", err)

    def test_create_rejects_empty_name(self):
        err = dashboard._room_body_error("/api/arena/rooms/create",
                                         {"name": "   ", "password": "secret123"})
        self.assertIn("name", err)

    def test_create_rejects_empty_password(self):
        err = dashboard._room_body_error("/api/arena/rooms/create",
                                         {"name": "test", "password": ""})
        self.assertIn("password", err)

    def test_create_accepts_valid(self):
        err = dashboard._room_body_error("/api/arena/rooms/create",
                                         {"name": "My Room", "password": "secret123"})
        self.assertIsNone(err)

    def test_join_requires_room_and_password(self):
        err = dashboard._room_body_error("/api/arena/rooms/join", {})
        self.assertIn("roomId", err)

        err = dashboard._room_body_error("/api/arena/rooms/join",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIn("password", err)

    def test_join_validates_room_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/join",
                                         {"roomId": "bad", "password": "secret123"})
        self.assertIn("roomId", err)

    def test_leave_requires_room_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/leave", {})
        self.assertIn("roomId", err)

    def test_leave_rejects_bad_room_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/leave", {"roomId": "bad"})
        self.assertIn("roomId", err)

    def test_leave_accepts_valid(self):
        err = dashboard._room_body_error("/api/arena/rooms/leave",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIsNone(err)

    def test_rename_requires_name(self):
        err = dashboard._room_body_error("/api/arena/rooms/rename",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIn("name", err)

    def test_password_requires_password(self):
        err = dashboard._room_body_error("/api/arena/rooms/password",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIn("password", err)

    def test_kick_requires_user_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/kick",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIn("userId", err)

    def test_kick_validates_user_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/kick",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv",
                                          "userId": "not-uuid"})
        self.assertIn("userId", err)

    def test_unban_requires_user_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/unban",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv"})
        self.assertIn("userId", err)

    def test_delete_requires_room_id(self):
        err = dashboard._room_body_error("/api/arena/rooms/delete", {})
        self.assertIn("roomId", err)

    def test_sign_out_others_validated(self):
        err = dashboard._room_body_error("/api/arena/rooms/password",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv",
                                          "password": "secret123",
                                          "signOutOthers": "yes"})
        self.assertIn("signOutOthers", err)

    def test_sign_out_others_accepts_bool(self):
        err = dashboard._room_body_error("/api/arena/rooms/password",
                                         {"roomId": "r_ABCDEFGHIJKLMNOPQRSTUv",
                                          "password": "secret123",
                                          "signOutOthers": True})
        self.assertIsNone(err)


class RoomPostPaths(unittest.TestCase):
    """ARENA_ROOM_POSTS is in POST_PATHS and routed."""

    def test_all_room_posts_in_post_paths(self):
        for p in dashboard.ARENA_ROOM_POSTS:
            self.assertIn(p, dashboard.POST_PATHS,
                          f"{p} not in POST_PATHS")


class ArenaProxyFunctions(unittest.TestCase):
    """arena.py room proxy functions reject bad IDs before any I/O."""

    def test_room_members_rejects_bad_id(self):
        code, resp = arena.room_members("bad")
        self.assertEqual(code, 400)

    def test_join_room_rejects_bad_id(self):
        code, resp = arena.join_room("bad", "pw")
        self.assertEqual(code, 400)

    def test_leave_room_rejects_bad_id(self):
        code, resp = arena.leave_room("bad")
        self.assertEqual(code, 400)

    def test_kick_rejects_bad_user_id(self):
        code, resp = arena.kick_room_member("r_ABCDEFGHIJKLMNOPQRSTUv", "bad")
        self.assertEqual(code, 400)

    def test_unban_rejects_bad_user_id(self):
        code, resp = arena.unban_room_member("r_ABCDEFGHIJKLMNOPQRSTUv", "bad")
        self.assertEqual(code, 400)

    def test_rename_rejects_bad_id(self):
        code, resp = arena.rename_room("bad", "New Name")
        self.assertEqual(code, 400)

    def test_set_password_rejects_bad_id(self):
        code, resp = arena.set_room_password("bad", "newpw123")
        self.assertEqual(code, 400)

    def test_delete_rejects_bad_id(self):
        code, resp = arena.delete_room("bad")
        self.assertEqual(code, 400)


if __name__ == "__main__":
    unittest.main()
