"""
Wire formats.

`StatPayload` is the privacy boundary. It uses `extra="forbid"`, so a client
that grows a new field cannot silently start leaking it — the server rejects the
whole submission until the field is added here deliberately. Nothing in this
module can carry prompt text, file paths, project names or session titles.
"""
from datetime import date
from typing import Annotated, Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator

SCHEMA_VERSION = 1

# Tool names are echoed back on the board, so only known built-ins are accepted.
# Anything else -- notably `mcp__<server>__<tool>`, which can carry an employer's
# or client's name -- must be bucketed into "Other" by the client. The server
# enforces the same rule so a careless client cannot leak one.
KNOWN_TOOLS = frozenset({
    "Bash", "BashOutput", "KillShell", "Read", "Write", "Edit", "NotebookEdit",
    "Glob", "Grep", "Task", "Agent", "WebFetch", "WebSearch", "TodoWrite",
    "ExitPlanMode", "EnterPlanMode", "SlashCommand", "Skill", "AskUserQuestion",
    "Artifact", "Workflow", "Monitor", "ToolSearch", "Other",
})

Handle = Annotated[str, Field(min_length=1, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class TokenCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    input: int = Field(0, ge=0)
    output: int = Field(0, ge=0)
    cacheRead: int = Field(0, ge=0)
    cacheCreation: int = Field(0, ge=0)


class ToolCount(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=48)
    count: int = Field(ge=0)

    @field_validator("name")
    @classmethod
    def _allowlisted(cls, v: str) -> str:
        return v if v in KNOWN_TOOLS else "Other"


class DayStat(BaseModel):
    """One day of raw activity. No score -- the server derives that."""

    model_config = ConfigDict(extra="forbid")

    date: date
    prompts: int = Field(0, ge=0)
    tools: int = Field(0, ge=0)
    artifacts: int = Field(0, ge=0)
    replies: int = Field(0, ge=0)
    tokens: TokenCounts = Field(default_factory=TokenCounts)
    toolBreakdown: list[ToolCount] = Field(default_factory=list, max_length=32)
    # Opt-in. Omitted entirely unless the user turned on cost sharing.
    costUSD: float | None = Field(None, ge=0)


class StatPayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schemaVersion: Literal[1]
    trainerName: str = Field("", max_length=32)
    days: list[DayStat] = Field(max_length=400)

    @field_validator("trainerName")
    @classmethod
    def _clean(cls, v: str) -> str:
        return " ".join(v.split())[:32]


# --- responses -------------------------------------------------------------

class BoardEntry(BaseModel):
    rank: int
    handle: str
    displayName: str
    trainerName: str
    avatarUrl: str
    xp: int
    level: int
    rankTitle: str
    prompts: int
    tools: int
    artifacts: int
    activeDays: int
    streak: int
    tokensTotal: int
    costUSD: float | None = None
    isYou: bool = False


class BoardResponse(BaseModel):
    window: str
    startsOn: date
    endsOn: date
    seasonName: str
    generatedAt: str
    entries: list[BoardEntry]


class MeResponse(BaseModel):
    handle: str
    displayName: str
    trainerName: str
    avatarUrl: str
    deviceLabel: str


class IngestResponse(BaseModel):
    accepted: int
    rejected: int
    notes: list[str] = Field(default_factory=list)


class PairRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    code: str = Field(min_length=4, max_length=32)
    label: str = Field("", max_length=64)


class PairResponse(BaseModel):
    token: str
    handle: str
    displayName: str
    avatarUrl: str


class TicketResponse(BaseModel):
    ticket: str
    expiresIn: int


# --- nudges ----------------------------------------------------------------

class SendNudgeRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    toHandle: str = Field(min_length=1, max_length=64)
    note: str = Field("", max_length=120)

    @field_validator("note")
    @classmethod
    def _clean_note(cls, v: str) -> str:
        return "".join(ch for ch in v if ch.isprintable()).strip()[:120]


class SendNudgeResponse(BaseModel):
    queued: bool
    deliveredLive: int = 0


class NudgeItem(BaseModel):
    fromHandle: str
    fromName: str
    note: str
    at: str


class NudgesResponse(BaseModel):
    nudges: list[NudgeItem] = Field(default_factory=list)


# --- pantry (Poke Coins, food, gifts) ---------------------------------------
# The literal limits here mirror app/pantry.py (BUY_MAX_QTY, GIFT_MAX_COINS,
# GIFT_MAX_QTY, CATALOG keys); change both together. Every int is strict, so
# `true` or `"3"` is a 422 rather than a quiet 1 or 3. A request carries a kind,
# an amount, a handle and a note -- never a session id, title or path, and
# `extra="forbid"` turns a stray one into a 422.

FoodKind = Literal[
    "berry", "bread", "riceball", "coffee", "bento", "noodles", "hotpot", "tonic", "elixir",
    "strawberry", "dango", "omelette", "watermelon", "shavedice", "curry",
    "apple", "sweetpotato", "pumpkinstew", "chestnuts", "cocoa", "oden",
]
RequestId = Annotated[str, Field(min_length=16, max_length=64, pattern=r"^[A-Za-z0-9_-]+$")]


class BuyRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: RequestId
    kind: FoodKind
    qty: Annotated[int, Field(ge=1, le=5, strict=True)] = 1


class EatRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: RequestId
    kind: FoodKind


class GiveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: RequestId
    toHandle: Handle
    coins: Annotated[int, Field(ge=0, le=5, strict=True)] = 0
    kind: FoodKind | None = None
    qty: Annotated[int, Field(ge=0, le=3, strict=True)] = 0
    note: str = Field("", max_length=80)

    @field_validator("note")
    @classmethod
    def _clean_note(cls, v: str) -> str:
        return " ".join("".join(c for c in v if c.isprintable()).split())[:80]

    @model_validator(mode="after")
    def _something_to_give(self) -> "GiveRequest":
        if self.qty > 0 and self.kind is None:
            raise ValueError("kind is required when qty > 0")
        if self.kind is not None and self.qty == 0:
            raise ValueError("qty is required with kind")
        if self.coins == 0 and self.qty == 0:
            raise ValueError("a gift needs coins or food")
        return self


class CatalogItem(BaseModel):
    kind: str
    name: str
    plural: str
    emoji: str
    price: int          # today's price (the special's discount applied)
    basePrice: int
    restoreMins: int
    revives: bool
    season: str         # "all" | "spring" | "summer" | "fall" | "winter"
    inStock: bool
    special: bool


class ClaimInfo(BaseModel):
    claimedToday: bool
    claimable: bool
    amount: int
    today: str
    nextClaimAt: str


class PantryLimits(BaseModel):
    buyMaxQty: int
    giftMaxCoins: int
    giftMaxQty: int
    giftsLeftToday: int


class GiftItem(BaseModel):
    fromHandle: str
    fromName: str
    coins: int
    kind: str | None
    qty: int
    note: str
    at: str


class PantryState(BaseModel):
    coins: int
    coinCap: int
    items: dict[str, int]
    itemCap: int
    catalog: list[CatalogItem]
    claim: ClaimInfo
    limits: PantryLimits
    recentGifts: list[GiftItem] = Field(default_factory=list)
    season: str = ""               # the UTC season the store stocks today
    special: str | None = None     # today's special kind, if any


class ClaimResponse(PantryState):
    op: Literal["claim"] = "claim"
    claimed: bool
    granted: int
    starter: bool
    full: bool


class BuyResponse(PantryState):
    op: Literal["buy"] = "buy"
    replayed: bool
    kind: str
    qty: int
    spent: int


class EatResponse(PantryState):
    op: Literal["eat"] = "eat"
    replayed: bool
    kind: str
    restoreMins: int
    revives: bool
    at: str


class SentGift(BaseModel):
    coins: int
    kind: str | None
    qty: int


class GiveResponse(PantryState):
    op: Literal["give"] = "give"
    replayed: bool
    toHandle: str
    sent: SentGift
    deliveredLive: int = 0


class DrainedGift(GiftItem):
    id: str


class GiftsResponse(BaseModel):
    gifts: list[DrainedGift] = Field(default_factory=list)


class QuestRewardRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")
    requestId: str = Field(max_length=100, pattern=r"^(quest|ach):[a-z0-9_]+:.+$")
    kind: Literal["quest", "achievement"]
    questId: str = Field(max_length=40)
    tier: Literal["bronze", "silver", "gold"] | None = None
    coins: int = Field(ge=1, le=15)


class QuestRewardResponse(BaseModel):
    ok: bool = True
    coins: int
    reward: int


# --- private rooms -----------------------------------------------------------

RoomId = Annotated[str, Field(pattern=r"^r_[A-Za-z0-9_-]{22}$")]
UserId = Annotated[
    str,
    Field(pattern=r"^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$"),
]


class CreateRoomRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    name: str = Field(max_length=200)
    password: str = Field(max_length=1024)


class JoinRoomRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: RoomId
    password: str = Field(max_length=1024)


class RoomRefRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: RoomId


class RenameRoomRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: RoomId
    name: str = Field(max_length=200)


class RoomPasswordRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: RoomId
    password: str = Field(max_length=1024)
    signOutOthers: bool = False


class RoomUserRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    roomId: RoomId
    userId: UserId


class RoomOut(BaseModel):
    id: str
    name: str
    ownerUserId: str
    ownerHandle: str
    ownerName: str
    online: int
    memberCount: int
    role: Literal["owner", "member", "banned"] | None = None
    createdAt: str


class LobbyOut(BaseModel):
    id: Literal["lobby"] = "lobby"
    name: str = "Lobby"
    online: int


class RoomLimits(BaseModel):
    nameMax: int
    passwordMin: int
    passwordMax: int
    maxOwned: int
    maxJoined: int
    maxMembers: int


class RoomDirectoryResponse(BaseModel):
    lobby: LobbyOut
    rooms: list[RoomOut]
    limits: RoomLimits


class RoomResponse(BaseModel):
    room: RoomOut
    already: bool = False


class LeaveRoomResponse(BaseModel):
    ok: bool = True
    deleted: bool = False
    newOwnerHandle: str | None = None


class RoomPasswordResponse(BaseModel):
    ok: bool = True
    signedOut: int = 0


class RoomOkResponse(BaseModel):
    ok: bool = True


class RoomMemberOut(BaseModel):
    userId: str
    handle: str
    displayName: str
    avatarUrl: str
    role: Literal["owner", "member"]
    online: bool
    joinedAt: str


class BannedOut(BaseModel):
    userId: str
    handle: str
    displayName: str
    avatarUrl: str


class RoomMembersResponse(BaseModel):
    roomId: str
    members: list[RoomMemberOut]
    banned: list[BannedOut] = Field(default_factory=list)


# --- cali (California Burrito taco Tuesdays) ---------------------------------
# The deal is buy-1-get-1 pooled across the whole table, so a client sends only
# what each person ordered; TT, the paid count and TPP are all derived in
# app/tacos.py. As everywhere else here, `extra="forbid"` and strict ints mean a
# stray field or a `"3"` is a 422 rather than something quietly wrong.

# `LogOrderRequest.date` is a field with a default, which binds the name in the
# class namespace and would shadow the `date` type while pydantic resolves the
# annotation. The alias keeps the wire name.
DinnerDate = date

DINER_NAME_MAX = 40
MAX_DINERS = 20
MAX_PER_VARIANT = 50


class TacoCounts(BaseModel):
    model_config = ConfigDict(extra="forbid")

    mildHard: Annotated[int, Field(ge=0, le=MAX_PER_VARIANT, strict=True)] = 0
    mildSoft: Annotated[int, Field(ge=0, le=MAX_PER_VARIANT, strict=True)] = 0
    wildHard: Annotated[int, Field(ge=0, le=MAX_PER_VARIANT, strict=True)] = 0
    wildSoft: Annotated[int, Field(ge=0, le=MAX_PER_VARIANT, strict=True)] = 0

    @property
    def total(self) -> int:
        return self.mildHard + self.mildSoft + self.wildHard + self.wildSoft


class DinerOrder(BaseModel):
    """One person's order. `handle` ties them to an Arena account; `name` covers
    a founder who never paired a device. A zero-taco diner is allowed -- they
    still showed up, which is what the board ranks on."""

    model_config = ConfigDict(extra="forbid")

    handle: Handle | None = None
    name: str = Field("", max_length=DINER_NAME_MAX)
    tacos: TacoCounts = Field(default_factory=TacoCounts)

    @field_validator("name")
    @classmethod
    def _clean_name(cls, v: str) -> str:
        return " ".join("".join(c for c in v if c.isprintable()).split())[:DINER_NAME_MAX]

    @model_validator(mode="after")
    def _has_identity(self) -> "DinerOrder":
        if self.handle is None and not self.name:
            raise ValueError("a diner needs a handle or a name")
        return self


class LogOrderRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    requestId: RequestId
    # Omitted means tonight (UTC). The server refuses a future date.
    date: DinnerDate | None = None
    diners: list[DinerOrder] = Field(min_length=1, max_length=MAX_DINERS)
    note: str = Field("", max_length=80)

    @field_validator("note")
    @classmethod
    def _clean_note(cls, v: str) -> str:
        return " ".join("".join(c for c in v if c.isprintable()).split())[:80]

    @model_validator(mode="after")
    def _no_duplicate_diners(self) -> "LogOrderRequest":
        seen = set()
        for d in self.diners:
            key = f"@{d.handle.lower()}" if d.handle else f"#{d.name.casefold()}"
            if key in seen:
                raise ValueError("the same diner is listed twice")
            seen.add(key)
        return self


class OrderDinerOut(BaseModel):
    handle: str | None
    name: str
    avatarUrl: str = ""
    tacos: TacoCounts
    total: int


class OrderOut(BaseModel):
    id: str
    date: date
    people: int
    totalTacos: int
    paidTacos: int
    freeTacos: int
    # TPP for this one dinner: TT / people, rounded to 2dp.
    tacosPerPerson: float
    note: str
    loggedByHandle: str
    createdAt: str
    diners: list[OrderDinerOut] = Field(default_factory=list)


class LogOrderResponse(BaseModel):
    order: OrderOut
    # True when this requestId already logged this dinner; nothing was written.
    replayed: bool = False


class OrdersResponse(BaseModel):
    orders: list[OrderOut] = Field(default_factory=list)


class CaliBoardEntry(BaseModel):
    rank: int
    handle: str | None
    name: str
    avatarUrl: str = ""
    # The ranking key: distinct dinner dates attended.
    tuesdays: int
    totalTacos: int
    # TPP across the window: TT / tuesdays, rounded to 2dp.
    tacosPerPerson: float
    mild: int
    wild: int
    hard: int
    soft: int
    isYou: bool = False


class CaliBoardResponse(BaseModel):
    window: str
    startsOn: date
    endsOn: date
    generatedAt: str
    orders: int
    totalTacos: int
    paidTacos: int
    freeTacos: int
    entries: list[CaliBoardEntry] = Field(default_factory=list)
