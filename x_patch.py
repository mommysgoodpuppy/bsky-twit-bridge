"""Patches keeping twikit 2.3.3 working against X's current responses.

Two things are broken upstream:

1. twikit looks for a literal `"ondemand.s":"<hash>"` pair in the homepage to build
   its transaction id, but X now splits that into two numeric-keyed maps: chunk id
   -> name (`59924:"ondemand.s"`) and chunk id -> hash (`59924:"7df43d9"`). Without
   the hash, twikit dies with "Couldn't get KEY_BYTE indices". Worse, the logged-out
   home page has since moved to an entirely new client (`x-web/entry-client-*`) that
   carries no chunk map at all, so the hash has to be sourced from one of the routes
   still served by the old `responsive-web` bundle.
2. X's user payload drops fields twikit reads unconditionally (an account with no
   links in its bio has `entities.description == {}`), so `User.__init__` raises
   KeyError before we ever see a tweet.
"""

import re
import sys

import twikit.user as user_module
import twikit.x_client_transaction.transaction as transaction

CHUNK_NAME_REGEX = re.compile(r'(\d{2,6}):"ondemand\.s"')

# Routes still served by the old responsive-web client, tried in order when the
# page twikit was handed doesn't carry the chunk map. Neither needs auth.
FALLBACK_PAGES = (
    'https://x.com/i/flow/login',
    'https://x.com/home',
    'https://x.com/?mx=2',
)

_original_get_indices = transaction.ClientTransaction.get_indices


def _find_on_demand_hash(html: str) -> str | None:
    # The literal `"ondemand.s":"<hash>"` form twikit expects, in case X ever
    # serves it again.
    literal = transaction.ON_DEMAND_FILE_REGEX.search(html)
    if literal:
        return literal.group(1)

    name_match = CHUNK_NAME_REGEX.search(html)
    if not name_match:
        return None
    chunk_id = name_match.group(1)
    # The same id appears in the name map and the hash map; take the one that
    # looks like a bundle hash rather than the name we just matched.
    for value in re.findall(rf'{chunk_id}:"([^"]+)"', html):
        if re.fullmatch(r'[0-9a-f]{6,10}', value):
            return value
    return None


async def _get_indices(self, home_page_response, session, headers):
    html = str(self.validate_response(home_page_response) or self.home_page_response)

    on_demand_hash = _find_on_demand_hash(html)
    tried = ['the home page']
    for url in FALLBACK_PAGES:
        if on_demand_hash:
            break
        try:
            response = await session.request(method='GET', url=url, headers=headers)
            on_demand_hash = _find_on_demand_hash(str(response.text))
        except Exception as error:  # noqa: BLE001 - any failure just means try the next page
            print(f'x_patch: {url} failed: {error}', file=sys.stderr)
        tried.append(url)

    if not on_demand_hash:
        raise Exception(
            "Couldn't find the ondemand.s bundle hash in any of: "
            + ', '.join(tried)
            + '. X has probably moved these routes to the new x-web client too; '
            'the transaction-id patch needs updating.'
        )

    url = (
        'https://abs.twimg.com/responsive-web/client-web/'
        f'ondemand.s.{on_demand_hash}a.js'
    )
    response = await session.request(method='GET', url=url, headers=headers)
    indices = [
        int(item.group(2))
        for item in transaction.INDICES_REGEX.finditer(str(response.text))
    ]
    if not indices:
        raise Exception("Couldn't get KEY_BYTE indices")
    return indices[0], indices[1:]


_original_user_init = user_module.User.__init__

# Fields twikit reads with [] that X no longer always sends.
_LEGACY_DEFAULTS = {
    'pinned_tweet_ids_str': [],
    'withheld_in_countries': [],
    'profile_interstitial_type': '',
    'possibly_sensitive': False,
    'can_dm': False,
    'can_media_tag': False,
    'want_retweets': False,
    'has_custom_timelines': False,
    'default_profile': False,
    'default_profile_image': False,
    'verified': False,
    'is_translator': False,
    'translator_type': 'none',
    'location': '',
    'description': '',
}


def _user_init(self, client, data):
    legacy = data.setdefault('legacy', {})
    for key, default in _LEGACY_DEFAULTS.items():
        legacy.setdefault(key, default)
    entities = legacy.setdefault('entities', {})
    entities.setdefault('description', {}).setdefault('urls', [])
    _original_user_init(self, client, data)


def apply() -> None:
    transaction.ClientTransaction.get_indices = _get_indices
    user_module.User.__init__ = _user_init
