"""Pokémon sprites go through the local disk cache (/api/sprite via pokeCached): every sprite
builder and fallback in the page and the battle game wraps its URL, and the cache folder is
gitignored (the sprites are third-party art and must never be committed)."""
import os
import re
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def read(rel):
    with open(os.path.join(ROOT, rel), encoding="utf-8") as f:
        return f.read()


class SpriteCacheWiring(unittest.TestCase):
    def test_helper_is_gated_and_encodes(self):
        src = read("ui/app/06-trainer-packs.js")
        self.assertIn('function pokeCached(url)', src)
        self.assertIn('"/api/sprite?u="+encodeURIComponent(url)', src)
        self.assertRegex(src, r'POKE_CACHE_ON = .*127\.0\.0\.1.*localhost')
        self.assertIn('return pokeCached((shiny ? SHOWDOWN_ANI_SHINY : SHOWDOWN_ANI) + slug + ".gif")', src)

    def test_every_sprite_src_and_fallback_is_cached(self):
        for rel in ("ui/app/06-trainer-packs.js", "ui/app/14-overlays.js", "ui/app/15-village.js"):
            src = read(rel)
            # data-alt (pkparaiso fallback) always wrapped
            for m in re.finditer(r'data-alt="\'\+([^\n]*?)\+\'"', src):
                self.assertTrue(m.group(1).startswith("pokeCached("), (rel, m.group(0)))
            # any src= / img.src= built from a sprite base goes through pokeCached or pokeAniSrc
            for m in re.finditer(r'(?:src="\'\+|\.src=)([^;\n]*?(?:POKE_ANIM|POKE_STATIC|PKPARAISO|SHOWDOWN)[^;\n]*)', src):
                self.assertTrue(m.group(1).startswith(("pokeCached(", "pokeAniSrc(")), (rel, m.group(0)))
        self.assertGreaterEqual(read("ui/app/06-trainer-packs.js").count("pokeCached("), 5)

    def test_battle_sprites_use_the_cache(self):
        src = read("games/pokebattle.js")
        self.assertIn("G.pokeCached(u)", src)
        self.assertIn("im.src = cachedSrc(u.u + u.f)", src)
        self.assertIn("img.src = cachedSrc(c.u + c.f)", src)
        self.assertNotRegex(src, r"\.src = (?!cachedSrc\()[^;]*\bu\.?[uf]\b")

    def test_cache_dir_is_gitignored(self):
        self.assertIn(".sprite-cache/", read(".gitignore").splitlines())


if __name__ == "__main__":
    unittest.main()
