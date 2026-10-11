"""Abilities (inspired by Blade Ball) and PlayStyles (inspired by EA FC 26).

Only the ids live here – the server validates what players equip. The effects
are simulated by the match host in client/js/game.js, and names, icons and
descriptions are in client/js/loadout.js.
"""

ABILITIES = {
    "dash", "blink", "shadow_step", "ninja_dash", "invisibility",
    "freeze", "forcefield", "pull", "telekinesis", "raging_deflection",
    "rapture", "swap", "hell_hook", "force", "time_hole",
}

PLAYSTYLES = {
    "finesse_shot", "power_shot", "chip_shot",
    "rapid", "technical", "trickster", "press_proven",
    "intercept", "anticipate", "slide_tackle", "jockey",
    "quick_step", "bruiser", "enforcer",
}

DEFAULT_ABILITY = "dash"
MAX_PLAYSTYLES = 2


def parse_playstyles(stored: str) -> list[str]:
    return [p for p in stored.split(",") if p in PLAYSTYLES][:MAX_PLAYSTYLES]


def validate(ability, playstyles) -> str | None:
    """Returns an error message, or None if the loadout is valid."""
    if ability not in ABILITIES:
        return "Unknown ability."
    if (not isinstance(playstyles, list) or len(playstyles) > MAX_PLAYSTYLES
            or len(set(playstyles)) != len(playstyles)
            or any(p not in PLAYSTYLES for p in playstyles)):
        return f"Pick up to {MAX_PLAYSTYLES} different PlayStyles."
    return None
