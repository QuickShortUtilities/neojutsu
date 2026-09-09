"""Translate GB Studio event scripts into NeoJutsu script.

Their events are a tree of typed nodes; ours is a small language of lines.
Enough of the two overlap that most of a script survives the trip: waits,
conditions, variables, calls to named routines, and the commands aimed at a
particular actor.

What comes across is the *shape* of the logic - the thing worth having,
because a generator can make ten thousand levels and cannot make one boss
that waits, fires, then walks away. Dialogue does not come across: the words
in a project belong to whoever wrote them, and the structure is what
transfers, so a spoken line becomes a spoken line with nothing in it.

Anything with no equivalent is counted rather than guessed at. That tally is
a list of what our language still cannot say, drawn from a real game instead
of from imagination.
"""
import json, re
from collections import Counter

DIRS = {'left': -1, 'right': 1, 'up': 1, 'down': -1}
ANGLES = {'right': 0, 'down': 90, 'left': 180, 'up': 270}


def slug(name):
    s = re.sub(r'[^A-Za-z0-9]+', '_', str(name or '')).strip('_').lower()
    if not s:
        s = 'routine'
    if s[0].isdigit():
        s = 'r' + s
    return s[:24]


def num(a, default=0):
    """Their values are {type, value} or a bare number."""
    if isinstance(a, dict):
        v = a.get('value', default)
        return num(v, default)
    try:
        return round(float(a), 3)
    except (TypeError, ValueError):
        return default


class Ctx:
    def __init__(self, actors=None, routines=None, scenes=None, self_tag=''):
        self.actors = actors or {}          # actor id -> tag
        self.routines = routines or {}      # custom event id -> routine name
        self.scenes = scenes or {}          # scene id -> room name
        self.self_tag = self_tag
        self.missing = Counter()
        self.used_routines = set()

    def tag(self, actor_id):
        if actor_id in ('$self$', 'self'):
            return self.self_tag or None
        if actor_id == 'player':
            return 'player'                  # the engine addresses bodies by name now
        return self.actors.get(actor_id)


def _q(s):
    return '"' + str(s).replace('\\', '').replace('"', "'")[:40] + '"'


def translate(nodes, ctx, depth=0):
    """A list of GB Studio nodes to a list of our source lines."""
    out = []
    if depth > 6 or not isinstance(nodes, list):
        return out
    for n in nodes:
        if not isinstance(n, dict):
            continue
        cmd = n.get('command')
        if not cmd:
            continue
        args = n.get('args') or {}
        kids = n.get('children') or {}
        name = cmd.replace('EVENT_', '')

        if name == 'WAIT':
            secs = num(args.get('time'), 0) or round(num(args.get('frames'), 0) / 60, 2)
            if secs > 0:
                out.append(f'wait {secs:g}')
            continue

        if name == 'TEXT':
            # The structure, not the words.
            out.append('talk ""')
            continue

        if name == 'SWITCH_SCENE':
            room = ctx.scenes.get(args.get('sceneId'))
            if room:
                out.append(f'goto {_q(room)}')
            else:
                ctx.missing[name + ' (unknown room)'] += 1
            continue

        if name == 'ACTOR_MOVE_RELATIVE':
            tag = ctx.tag(args.get('actorId'))
            if tag:
                out.append(f'nudge {_q(tag)} {num(args.get("x")):g} {num(args.get("y")):g}')
            else:
                ctx.missing[name + ' (player)'] += 1
            continue

        if name in ('DEC_VALUE', 'INC_VALUE'):
            v = f'v{slug(args.get("variable"))}'
            out.append(f'set {v} {v} {"-" if name == "DEC_VALUE" else "+"} 1')
            continue

        if name == 'SOUND_PLAY_EFFECT':
            out.append('sound "coin"')
            continue

        if name == 'SET_VALUE':
            out.append(f'set v{slug(args.get("variable"))} {num(args.get("value"))}')
            continue

        if name == 'IF':
            cond = args.get('condition') or {}
            var = cond.get('value') if isinstance(cond, dict) else args.get('variable')
            out.append(f'if v{slug(var)}')
            out += ['  ' + l for l in translate(kids.get('true'), ctx, depth + 1)]
            other = translate(kids.get('false'), ctx, depth + 1)
            if other:
                out.append('else')
                out += ['  ' + l for l in other]
            out.append('end')
            continue

        if name == 'CALL_CUSTOM_EVENT':
            r = ctx.routines.get(args.get('customEventId'))
            if r:
                ctx.used_routines.add(r)
                out.append(f'do {r}')
            else:
                ctx.missing[name] += 1
            continue

        if name in ('ACTOR_MOVE_TO', 'ACTOR_SET_DIRECTION', 'ACTOR_DEACTIVATE',
                    'ACTOR_ACTIVATE', 'ACTOR_STOP_UPDATE', 'LAUNCH_PROJECTILE',
                    'ACTOR_SET_POSITION', 'ACTOR_EMOTE'):
            tag = ctx.tag(args.get('actorId'))
            if not tag:
                ctx.missing[name + ' (player)'] += 1
                continue
            if name == 'ACTOR_MOVE_TO':
                out.append(f'move {_q(tag)} {num(args.get("x")):g} {num(args.get("y")):g}')
            elif name == 'ACTOR_SET_DIRECTION':
                d = args.get('direction')
                d = d.get('value') if isinstance(d, dict) else d
                out.append(f'face {_q(tag)} {DIRS.get(d, 1)}')
            elif name == 'ACTOR_DEACTIVATE':
                out.append(f'hide {_q(tag)}')
            elif name == 'ACTOR_ACTIVATE':
                out.append(f'show {_q(tag)}')
            elif name == 'ACTOR_STOP_UPDATE':
                out.append(f'stop {_q(tag)}')
            elif name == 'ACTOR_SET_POSITION':
                out.append(f'place {_q(tag)} {num(args.get("x")):g} {num(args.get("y")):g}')
            elif name == 'ACTOR_EMOTE':
                out.append(f'emote {_q(tag)} "!"')
            else:
                d = args.get('direction')
                d = d.get('value') if isinstance(d, dict) else d
                out.append(f'shoot {_q(tag)} {ANGLES.get(d, 0)}')
            continue

        # Nested bodies we do not have a verb for still carry logic worth
        # keeping, so their contents are flattened rather than thrown away.
        inner = kids.get('script') or kids.get('true')
        if inner:
            out += translate(inner, ctx, depth + 1)
        ctx.missing[name] += 1
    return out


ACTION_WORDS = {
    'wait': 'waits', 'talk': 'someone speaks', 'move': 'walks an actor somewhere',
    'goto': 'leaves for another room', 'nudge': 'shifts an actor',
    'hide': 'takes an actor off stage', 'show': 'brings one back', 'face': 'turns one round',
    'shoot': 'fires', 'stop': 'stops one', 'set': 'remembers something',
    'if': 'checks something first', 'do': 'runs a routine',
}


def describe(lines, event):
    """A plain sentence about what a translated script does."""
    verbs = []
    for l in lines:
        head = l.strip().split(' ')[0]
        w = ACTION_WORDS.get(head)
        if w and w not in verbs:
            verbs.append(w)
    if not verbs:
        return None
    when = {'start': 'When the game starts', 'collect': 'When something is collected',
            'hurt': 'When the player is hit', 'kill': 'When an enemy dies',
            'land': 'On landing', 'win': 'On winning', 'lose': 'On losing',
            'tick': 'Every frame'}.get(event, 'When the game starts')
    if len(verbs) > 4:
        verbs = verbs[:4] + ['and more']
    return f'{when}: a sequence that ' + ', then '.join(verbs) + '.'
