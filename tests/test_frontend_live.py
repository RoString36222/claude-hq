"""Frontend behavior of the live view (issue #47), tested by running the real
functions from index.html under Node with small stubs. Skipped when Node isn't
installed: the repo has no JS toolchain, this only borrows one if it's there."""
import json
import os
import re
import shutil
import subprocess
import sys
import unittest

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
NODE = shutil.which("node")

sys.path.insert(0, ROOT)
import dashboard  # noqa: E402

HTML = dashboard.assemble_index()   # index.html with its ui/ parts stitched in, as served


def js_function(name):
    """Source of the top-level `function name(...){...}` in index.html (brace-matched,
    skipping string literals and line comments)."""
    m = re.search(r"^function %s\(" % re.escape(name), HTML, re.M)
    if not m:
        raise AssertionError("index.html has no function %s" % name)
    i = HTML.index("{", m.end())
    depth, q = 0, None
    while True:
        c = HTML[i]
        if q:
            if c == "\\":
                i += 2
                continue
            if c == q:
                q = None
        elif c in "'\"`":
            q = c
        elif c == "/" and HTML[i + 1] == "/":
            i = HTML.index("\n", i)
            continue
        elif c == "{":
            depth += 1
        elif c == "}":
            depth -= 1
            if depth == 0:
                return HTML[m.start():i + 1]
        i += 1


def run_js(names, body):
    """Run `body` after defining the named index.html functions; returns the JSON
    the body prints via out(value)."""
    src = "\n".join(js_function(n) for n in names)
    prog = ("function out(v){ process.stdout.write(JSON.stringify(v)); }\n" + src + "\n" + body)
    r = subprocess.run([NODE, "-e", prog], capture_output=True, text=True, timeout=30)
    if r.returncode != 0:
        raise AssertionError("node failed:\n" + r.stderr)
    return json.loads(r.stdout)


LOCALSTORAGE = """
var LS={}; var localStorage={getItem:function(k){ return k in LS ? LS[k] : null; },
  setItem:function(k,v){ LS[k]=String(v); }};
"""


@unittest.skipUnless(NODE, "node not installed")
class QuestMetricsTest(unittest.TestCase):
    def test_apex_count_reads_backend_species_shape(self):
        dex = {"species": [
            {"caught": True, "maxStage": 4}, {"caught": True, "maxStage": 3},
            {"caught": False, "maxStage": 4}, {"caught": True, "maxStage": 4},
            {"caught": True}, None]}
        got = run_js(["dexApexCount"], "out([dexApexCount(%s), dexApexCount(null), dexApexCount({entries:[{stage:'Apex'}]})]);"
                     % json.dumps(dex))
        self.assertEqual(got, [2, 0, 0])

    def test_quest_metric_apex_uses_helper(self):
        got = run_js(["dexApexCount", "questMetric"],
                     "var STATE=null, PANTRY=null;\n"
                     "out(questMetric('apexCount', null, {species:[{caught:true,maxStage:4}]}, {}));")
        self.assertEqual(got, 1)

    def test_meals_today_counter_is_dated_and_once_per_request(self):
        got = run_js(["todayStr", "mealsTodayLoad", "mealsTodayCount", "mealsTodayBump"], LOCALSTORAGE + """
var a=mealsTodayCount();
mealsTodayBump("rid-aaaaaaaaaaaaaaaa"); mealsTodayBump("rid-aaaaaaaaaaaaaaaa"); mealsTodayBump("rid-bbbbbbbbbbbbbbbb");
var b=mealsTodayCount();
LS.hq_meals_today=JSON.stringify({date:"2000-01-01", n:7, rids:[]});
var c=mealsTodayCount();
LS.hq_meals_today="5";   // the old (never written) numeric shape
var d=mealsTodayCount();
LS.hq_meals_today="{nope";
var e=mealsTodayCount();
out([a,b,c,d,e]);
""")
        self.assertEqual(got, [0, 2, 0, 0, 0])

    def test_quest_metric_today_fed_reads_counter(self):
        got = run_js(["todayStr", "mealsTodayLoad", "mealsTodayCount", "mealsTodayBump", "questMetric"],
                     LOCALSTORAGE + "var STATE=null, PANTRY=null; mealsTodayBump('x'); out(questMetric('todayFed', null, null, {}));")
        self.assertEqual(got, 1)

    def test_successful_eat_bumps_counter(self):
        src = js_function("pantryEat")
        self.assertIn("mealsTodayBump(rid)", src)
        self.assertRegex(src, r"res\.status===200\)\{[^}]*mealsTodayBump\(rid\)")


@unittest.skipUnless(NODE, "node not installed")
class PokedexFetchTest(unittest.TestCase):
    def test_one_shared_request_within_ttl_and_failures_not_cached(self):
        got = run_js(["fetchPokedex"], """
var DEX_FETCH={p:null, at:0}, DEX_FETCH_TTL=30000, calls=0, fail=false, now=1000;
Date.now=function(){ return now; };
function fetch(url){ calls++; var f=fail;
  return Promise.resolve({ok:!f, status:f?500:200, json:function(){ return Promise.resolve({url:url, n:calls}); }}); }
var a=fetchPokedex(), b=fetchPokedex();
var same=(a===b);
now+=29000; var c=fetchPokedex(); var stillSame=(c===a);
now+=2000; var d=fetchPokedex(); var fresh=(d!==a);
Promise.all([a,d]).then(function(r){
  var callsBefore=calls;
  now+=31000; fail=true;
  var e=fetchPokedex();
  e.catch(function(){}).then(function(){ return Promise.resolve(); }).then(function(){
    fail=false; var g=fetchPokedex();
    g.then(function(x){ out({same:same, stillSame:stillSame, fresh:fresh, url:r[0].url, callsBefore:callsBefore, retried:calls, ok:x.n}); });
  });
});
""")
        self.assertTrue(got["same"])
        self.assertTrue(got["stillSame"])
        self.assertTrue(got["fresh"])
        self.assertEqual(got["url"], "/api/pokedex")
        self.assertEqual(got["callsBefore"], 2)
        self.assertEqual(got["retried"], 4)   # the failure wasn't reused

    def test_all_readers_use_the_shared_fetch(self):
        self.assertEqual(HTML.count("fetch('/api/pokedex'") + HTML.count('fetch("/api/pokedex"'), 1)
        for fn in ("primeHighWater", "loadTrainerDex", "loadPokedex", "loadQuests"):
            self.assertIn("fetchPokedex()", js_function(fn), fn)


@unittest.skipUnless(NODE, "node not installed")
class VoiceGuardsTest(unittest.TestCase):
    def test_may_add_peer(self):
        got = run_js(["voiceMayAddPeer"], """
var VCHAN_MAX=3, VCHAN={peer:"aaaaaaaaaaaaaaaa", peers:{}}, ARENA={you:{userId:"me"}};
var r=[];
r.push(voiceMayAddPeer("bbbbbbbbbbbbbbbb", {userId:"u1"}));   // ok
r.push(voiceMayAddPeer("aaaaaaaaaaaaaaaa", {userId:"u1"}));   // our own peer id
r.push(voiceMayAddPeer("cccccccccccccccc", {userId:"me"}));   // my other tab
VCHAN.peers={x:{}, y:{}};
r.push(voiceMayAddPeer("dddddddddddddddd", {userId:"u2"}));   // full: me + 2 = VCHAN_MAX
out(r);
""")
        self.assertEqual(got, [True, False, False, False])

    def test_incoming_offer_checks_guard_before_making_a_peer(self):
        src = js_function("voiceOnSignal")
        offer = src[src.index('d.kind === "offer"'):]
        self.assertLess(offer.index("voiceMayAddPeer"), offer.index("voiceMakePeer"))
        self.assertIn("voiceMayAddPeer", js_function("voicePair"))

    def test_peer_evo_splash_throttled_per_user(self):
        got = run_js(["peerEvoAllowed"], """
var PEER_EVO_GAP_MS=60000, PEER_EVO_LAST={};
out([peerEvoAllowed("u1",0), peerEvoAllowed("u1",59999), peerEvoAllowed("u2",1000),
     peerEvoAllowed("u1",60000), peerEvoAllowed(undefined,0), peerEvoAllowed(null,10)]);
""")
        self.assertEqual(got, [True, False, True, True, True, False])
        self.assertIn("peerEvoAllowed(", js_function("arenaOnEvo"))


PARTY_STUBS = """
var QUERY="", SORT="status", FILTER="all", FILTERTAG="", FILTERFOLDER="", STALE_OPEN=false;
var PANTRY={store:"off"}, EVO_CHOICE={};
function cfg(){ return {creaturePack:"monsters"}; }
function fzOf(){ return null; }
function creatureStage(c){ return (c&&c.stage)|0; }
"""


@unittest.skipUnless(NODE, "node not installed")
class PartySigTest(unittest.TestCase):
    def test_volatile_fields_do_not_change_signature_but_reorder_does(self):
        got = run_js(["partySig"], PARTY_STUBS + """
function S(id, age, out, extra){ var s={id:id, sessionId:id, status:"working", title:"T"+id, creature:{species:1, stage:2},
  ageSecs:age, tokens:{output:out}, now:"Bash: x", lastPrompt:"p", lastReply:"r", promptCount:3, links:[], spark:[1]};
  for(var k in (extra||{})) s[k]=extra[k]; return s; }
var a=partySig([S("a",10,5), S("b",20,9)]);
var b=partySig([S("a",99,50,{now:"Read: y", lastPrompt:"q", lastReply:"z", promptCount:9, links:[{url:"u"}], spark:[3,4]}), S("b",200,90)]);
SORT="recent";
var c=partySig([S("a",10,5), S("b",20,9)]);
var d=partySig([S("a",15,5), S("b",25,9)]);    // ages move, order same
var e=partySig([S("a",30,5), S("b",25,9)]);    // order flips
SORT="tokens";
var f=partySig([S("a",10,5), S("b",20,9)]);
var g=partySig([S("a",10,10), S("b",20,9)]);   // a overtakes b
out([a===b, c===d, d===e, f===g]);
""")
        self.assertEqual(got, [True, True, False, False])

    def test_card_text_helpers(self):
        got = run_js(["fmtAge", "cardPromptsText", "cardAgeText", "cardLinesKey", "cardLinksKey", "cardFootKey"], """
out([cardPromptsText({promptCount:1}), cardPromptsText({}), cardAgeText({ageSecs:125}), cardAgeText({}),
     cardLinesKey({firstPrompt:"a", lastReply:"b"})===cardLinesKey({firstPrompt:"a", lastReply:"b"}),
     cardLinesKey({lastReply:"b"})===cardLinesKey({lastReply:"c"}),
     cardLinksKey({links:[{url:"x"}]})===cardLinksKey({links:[{url:"y"}]}),
     cardFootKey({tokens:{output:1}})===cardFootKey({tokens:{output:2}}),
     cardFootKey({spark:[1]})===cardFootKey({spark:[2]})]);
""")
        self.assertEqual(got, ["1 prompt", "0 prompts", "2m ago", "— ago", True, False, False, False, False])

    def test_unchanged_party_patches_cards_in_place(self):
        src = js_function("renderParty")
        self.assertIn("patchCards(sessions)", src)
        card = js_function("buildCard")
        for role in ("pc", "age", "now", "nowtxt", "lines", "links", "foot"):
            self.assertIn('data-role="%s"' % role if role in ("pc", "age") else '"data-role","%s"' % role, card, role)
        patch = js_function("patchCards")
        for role in ("pc", "age", "now", "nowtxt", "lines", "links", "foot"):
            self.assertIn('[data-role="%s"]' % role, patch, role)


FAKE_SELECT = """
function el(tag){ return {tag:tag, value:"", textContent:""}; }
function mkSel(){ var s={_sig:undefined, builds:0, value:"", kids:[], cls:{},
  appendChild:function(o){ this.kids.push(o); },
  classList:{toggle:function(){}} };
  Object.defineProperty(s,"innerHTML",{set:function(v){ s.kids=[]; s.builds++; }});
  return s; }
var SEL=mkSel(); function $(){ return SEL; }
var document={activeElement:null};
"""


@unittest.skipUnless(NODE, "node not installed")
class RenderGuardsTest(unittest.TestCase):
    def test_tag_select_rebuilds_only_on_change_and_never_while_focused(self):
        got = run_js(["renderTagFilter"], FAKE_SELECT + """
var FILTERTAG="";
var ss=[{tags:["a","b"]}];
renderTagFilter(ss); renderTagFilter(ss);
var once=SEL.builds;
document.activeElement=SEL;
renderTagFilter([{tags:["a","b","c"]}]);
var focused=SEL.builds;
document.activeElement=null;
renderTagFilter([{tags:["a","b","c"]}]);
out([once, focused, SEL.builds, SEL.kids.length]);
""")
        self.assertEqual(got, [1, 1, 2, 4])

    def test_folder_select_rebuilds_only_on_change_and_never_while_focused(self):
        got = run_js(["prettyFolder", "prettyFolderShort", "renderFolderFilter"], FAKE_SELECT + """
var FILTERFOLDER="";
var ss=[{folder:"x"},{folder:"y"}];
renderFolderFilter(ss); renderFolderFilter(ss);
var once=SEL.builds;
renderFolderFilter(ss.concat([{folder:"y"}]));    // a count changed
var counted=SEL.builds;
document.activeElement=SEL;
renderFolderFilter([{folder:"z"}]);
out([once, counted, SEL.builds]);
""")
        self.assertEqual(got, [1, 2, 2])

    def test_hidden_tab_skips_painting_but_still_notifies(self):
        names = ["render"]
        calls = ["syncConfig", "seedHighWaterFromSessions", "renderSeason", "renderInsights", "renderTagFilter",
                 "renderFolderFilter", "renderParty", "renderFeed", "renderAlertBanner", "renderHealth",
                 "renderTrainerCard", "maybeRecap", "renderGymCard", "renderNextUp", "renderGym", "renderVillage",
                 "checkTransitions", "checkCelebration", "checkEvolution", "checkFatigue", "refreshDrawerCare",
                 "updateDocTitle", "arenaStatusTick", "renderFocus", "renderWarroom", "renderCmdk", "relTime"]
        stubs = "var CALLED=[];\n" + "".join(
            "function %s(){ CALLED.push('%s'); }\n" % (c, c) for c in calls)
        got = run_js(names, stubs + """
var RENDER_DIRTY=false, STATE_AT=0, VIEW="live", FOCUS_ID=null, WARROOM_ON=false, CMDK_OPEN=false;
var STATE={sessions:[{id:"a", creature:{}}], season:{}, feed:[], health:{}, config:{}, updated:""};
var NODE={textContent:""}; function $(){ return NODE; }
var document={hidden:true};
render();
var hidden=CALLED.slice(), dirty=RENDER_DIRTY;
CALLED=[]; document.hidden=false; render();
out({hidden:hidden, dirty:dirty, after:RENDER_DIRTY, shown:CALLED});
""")
        self.assertTrue(got["dirty"])
        self.assertFalse(got["after"])
        for c in ("checkTransitions", "checkFatigue", "updateDocTitle"):
            self.assertIn(c, got["hidden"])
        for c in ("renderParty", "renderFeed", "renderNextUp", "renderGymCard", "renderTagFilter"):
            self.assertNotIn(c, got["hidden"])
            self.assertIn(c, got["shown"])

    def test_visibility_return_renders_pending_update(self):
        m = re.search(r'document\.addEventListener\("visibilitychange", function\(\)\{\n  if\(document\.hidden\)\{ stopPoll\(\); return; \}(.*?)\n\}\);',
                      HTML, re.S)
        self.assertTrue(m)
        self.assertIn("if(RENDER_DIRTY && STATE) render();", m.group(1))

    def test_section_signatures_present(self):
        self.assertIn("FEED_SIG", js_function("renderFeed"))
        self.assertIn("GYMCARD_SIG", js_function("renderGymCard"))
        self.assertIn("wrap._sig", js_function("renderNextUp"))


class EscapingTest(unittest.TestCase):
    def test_no_esc_into_textcontent(self):
        bad = [ln for ln in HTML.splitlines() if re.search(r"textContent\s*=[^=;][^;]*\besc\(", ln)]
        self.assertEqual(bad, [])

    def test_next_up_subtitle_not_escaped(self):
        self.assertNotIn('esc(prettyFolder(s.folder||""))', HTML)


if __name__ == "__main__":
    unittest.main()


@unittest.skipUnless(NODE, "node not installed")
class FocusComboTests(unittest.TestCase):
    """HQ 2.1 combo + focus: ×1, +0.25 every 30 minutes of unbroken work, up to ×2."""

    def test_multiplier_steps(self):
        out = run_js(["focusMult"], "var FOCUS_STEP = 30*60*1000, FOCUS_MAX = 2;\n"
                     "out([0, 29, 30, 61, 90, 119, 120, 600].map(function(m){ return focusMult(m*60000); }));")
        self.assertEqual(out, [1, 1, 1.25, 1.5, 1.75, 1.75, 2, 2])


@unittest.skipUnless(NODE, "node not installed")
class QuickPlayPartyTests(unittest.TestCase):
    """HQ 2.1 Quick Play rooms are recognised; a matched status moves you there and opens the game."""

    def test_qp_room_ids(self):
        out = run_js(["arenaIsQp"], "out(['qp_0123456789ab','qp_XYZ','r_abc','lobby',null].map(arenaIsQp));")
        self.assertEqual(out, [True, False, False, False, False])

    def test_matched_moves_room_and_opens_game(self):
        out = run_js(["arenaIsQp", "playName", "qpApply"], """
var window={}, PLAY_GAMES=[["kart","k","Kart Racing"]], QP={state:"waiting"}, went=[], opened=[], toasts=[];
function toast(t){ toasts.push(t); } function qpRender(){} function arenaGoRoom(id, info){ went.push([id, info.name]); }
function playOpen(g){ opened.push(g); } function playGet(){ throw new Error("no poll after a match"); }
qpApply({state:"matched", room:"qp_0123456789ab", game:"kart", players:3});
qpApply({state:"matched", room:"r_evil", game:"kart", players:3});
out({went:went, opened:opened, state:QP.state, toast:toasts[0]});""")
        self.assertEqual(out["went"], [["qp_0123456789ab", "Quick Play: Kart Racing"]])
        self.assertEqual(out["opened"], ["kart"])
        self.assertEqual(out["state"], "idle")
        self.assertIn("3 players", out["toast"])


@unittest.skipUnless(NODE, "node not installed")
class OneLevelTests(unittest.TestCase):
    """Your level is the Arena's HQ level when paired (the one your building and friends see),
    else the 30-day season level: never two different numbers called 'your level'."""

    def test_hq_level_wins_when_paired(self):
        out = run_js(["myLevel"], """
var STATE={season:{level:26, rank:"Prompt Deity", pct:65.7, xpIntoLevel:2314, xpForLevel:3520}};
var PROG={data:null}; var a=myLevel();
PROG.data={level:30, rank:"Prompt Deity", xpIntoLevel:3860, xpForLevel:4000}; var b=myLevel();
out([a.level, a.hq, b.level, b.hq, b.pct]);""")
        self.assertEqual(out, [26, False, 30, True, 96.5])


@unittest.skipUnless(NODE, "node not installed")
class TalkWhereYouStandTests(unittest.TestCase):
    """HQ 2.1 talk: the Arena room follows you around the 3D HQ, never drops a call, and
    goes back to where you were when you leave the HQ view."""

    PRE = """
var VIEW="hq", HQ3D={inst:{}, world:"city", visit:null}, HQ_REMOTE={open:true, me:"aaaaaaaa-0000-4000-8000-000000000001"}, VCHAN={on:false};
var ARENA={roomId:"lobby"}, went=[];
function hqCityOn(){ return HQ_REMOTE.open && !!HQ_REMOTE.me; }
function arenaGoRoom(id, info){ went.push(id); ARENA.roomId=id; }
var TALK={prev:null, refused:null, offer:null};
"""

    def run_follow(self, body):
        return run_js(["arenaIsHqRoom", "hqTalkRoom", "hqTalkPlace", "hqTalkFollow"], self.PRE + body)

    def test_follows_city_visit_and_home(self):
        out = self.run_follow("""
hqTalkFollow(); var a=ARENA.roomId;
HQ3D.world="lobby"; hqTalkFollow(); var b=ARENA.roomId;
HQ3D.visit={userId:"0123abcd-0123-4567-89ab-0123456789ab", trainerName:"Ann"}; hqTalkFollow(); var c=ARENA.roomId, nm=hqTalkPlace(c);
HQ3D.visit=null; VIEW="live"; hqTalkFollow();
out([a, b, c, nm, ARENA.roomId]);""")
        self.assertEqual(out, ["hq_city", "hq_aaaaaaaa-0000-4000-8000-000000000001", "hq_0123abcd-0123-4567-89ab-0123456789ab", "Ann's HQ", "lobby"])

    def test_never_drops_a_call_and_private_means_no_move(self):
        out = self.run_follow("""
VCHAN.on=true; hqTalkFollow(); var a=[ARENA.roomId, TALK.offer];
VCHAN.on=false; HQ_REMOTE.open=false; HQ3D.world="base"; TALK.offer=null; hqTalkFollow();
out([a, ARENA.roomId, went]);""")
        self.assertEqual(out, [["lobby", "hq_city"], "lobby", []])


class TalkPanelMentionsTests(unittest.TestCase):
    """The HQ talk panel has the Arena chat's @mentions: one shared picker, its own list."""

    def test_wiring(self):
        html = dashboard.assemble_index()
        self.assertIn('id="hqTalkInput" maxlength="500" autocomplete="off" data-mentions="hqTalkMentions"', html)
        self.assertIn('id="hqTalkMentions" role="listbox"', html)
        self.assertIn('arenaMentionBind(i);          // @mentions, as in the Arena\'s chat', html)
        self.assertIn('if(e.key==="Enter" && !e.defaultPrevented)', html)
        self.assertIn('arenaRenderMessageText(txt, line.text)', html)
