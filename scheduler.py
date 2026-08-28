"""Shared FSRS scheduler configuration.

learning_steps and relearning_steps are empty so every rating goes straight
to long-term FSRS scheduling instead of same-day re-drilling.
"""

from functools import lru_cache

from fsrs import Scheduler


@lru_cache(maxsize=1)
def get_scheduler() -> Scheduler:
    return Scheduler(learning_steps=(), relearning_steps=())
