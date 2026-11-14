// Audius plugin for MusicFree.
// Uses the public Audius REST API (no key, no login required).
// Audio is officially distributed by Audius - no scraping of third-party
// copyrighted catalogues.
//
// API entry point: https://api.audius.co/v1/...
//   /tracks/search?query=&app_name=     - music search
//   /tracks/trending?app_name=          - trending chart
//   /playlists/search?query=&app_name=  - playlist search
//   /playlists/{id}?app_name=           - playlist detail
//   /tracks/{id}/stream?app_name=       - audio stream (302 -> CDN, real mp3)
//   /users/{id}/tracks?app_name=        - artist tracks
//
// Notes on the API:
//   * is_streamable === true  -> the track has a playable stream
//   * duration is already in seconds
//   * artwork / profile_picture are maps of size -> url ("150x150", "480x480", "1000x1000")
//   * there is NO lyrics endpoint (returns 404) - getLyric is not implemented

const APP_NAME = "MusicFree";
const API_BASE = "https://api.audius.co/v1";
const PAGE_SIZE = 30;

/** Pick a cover image, preferring a mid-sized one. */
function pickImage(imageMap) {
    if (!imageMap || typeof imageMap !== "object") {
        return undefined;
    }
    return (
        imageMap["480x480"] ||
        imageMap["150x150"] ||
        imageMap["1000x1000"] ||
        undefined
    );
}

/** Convert an Audius track into a MusicFree IMusicItem. */
function toMusicItem(track) {
    if (!track || !track.id) {
        return null;
    }
    return {
        id: track.id,
        // Audius exposes genre + mood; show them as the "album" slot so the
        // list view is not empty. The real album concept does not exist here.
        title: track.title || "",
        artist: track.user?.name || "",
        duration: track.duration || undefined,
        album: track.genre || track.mood || undefined,
        artwork: pickImage(track.artwork) || pickImage(track.user?.profile_picture),
        // Extra fields, kept for later use / de-duplication.
        permalink: track.permalink,
        userId: track.user?.id,
        isStreamable: track.is_streamable === true,
    };
}

/** Convert a track and keep it only when it actually has a playable stream. */
function toPlayableMusic(track) {
    const item = toMusicItem(track);
    return item && item.isStreamable ? item : null;
}

/** Convert an Audius playlist into a MusicFree IMusicSheetItem.
 *
 * Note on the API: a playlist returned by /playlists/search carries
 * `track_count: N` but an EMPTY `tracks: []` array - the actual track ids live
 * in `playlist_contents[].track_id`. Only /playlists/{id} returns a populated
 * `tracks` array. So we must not rely on `tracks` from search results.
 */
function toSheetItem(playlist) {
    const inlineTracks = Array.isArray(playlist.tracks) ? playlist.tracks : [];
    return {
        id: playlist.id,
        title: playlist.playlist_name || "",
        artist: playlist.user?.name || "",
        artwork:
            pickImage(playlist.artwork) ||
            pickImage(playlist.user?.profile_picture),
        description: playlist.description || undefined,
        trackCount: playlist.track_count ?? undefined,
        musicList: inlineTracks
            .map(toPlayableMusic)
            .filter((it) => it !== null),
    };
}

async function apiGet(path, params) {
    const search = new URLSearchParams(
        Object.assign({ app_name: APP_NAME }, params || {}),
    );
    const url = `${API_BASE}${path}?${search.toString()}`;
    const res = await fetch(url);
    if (!res.ok) {
        throw new Error(`Audius API ${res.status} for ${path}`);
    }
    return await res.json();
}

/**
 * Fetch a playlist's tracks.
 *
 * /playlists/{id} returns `tracks` as an array of track objects, but it is not
 * guaranteed to be populated (search results return an empty array plus only
 * `playlist_contents[].track_id`). Strategy: read the detail response, use its
 * inline tracks when non-empty, otherwise resolve the ids from playlist_contents.
 */
async function fetchPlaylistTracks(playlistId) {
    const res = await apiGet(`/playlists/${playlistId}`);
    // Important: /playlists/{id} returns `data` as an ARRAY with one element,
    // while /playlists/search returns `data` as a plain array of playlists.
    let playlist = res.data;
    if (Array.isArray(playlist)) {
        playlist = playlist[0];
    }
    if (!playlist) {
        return [];
    }

    const inline = (playlist.tracks || [])
        .map(toPlayableMusic)
        .filter((it) => it !== null);
    if (inline.length) {
        return inline;
    }

    // Fall back to the ids listed in playlist_contents. The batch form
    // (/tracks?id=a,b) returns an empty list in practice, so resolve one by one.
    const ids = (playlist.playlist_contents || [])
        .map((it) => it && it.track_id)
        .filter(Boolean);
    if (!ids.length) {
        return [];
    }
    const tracks = await Promise.all(
        ids.map(async (id) => {
            try {
                const one = await apiGet(`/tracks/${id}`);
                return toPlayableMusic(one.data);
            } catch (e) {
                return null;
            }
        }),
    );
    return tracks.filter((it) => it !== null);
}

async function searchMusic(keyword, page) {
    const res = await apiGet("/tracks/search", {
        query: keyword,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
    });
    const list = (res.data || [])
        .map(toPlayableMusic)
        .filter((it) => it !== null);
    return {
        isEnd: list.length < PAGE_SIZE,
        data: list,
    };
}

async function searchPlaylist(keyword, page) {
    const res = await apiGet("/playlists/search", {
        query: keyword,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
    });
    const list = (res.data || []).map(toSheetItem);
    return {
        isEnd: list.length < PAGE_SIZE,
        data: list,
    };
}

async function searchArtist(keyword, page) {
    const res = await apiGet("/users/search", {
        query: keyword,
        limit: PAGE_SIZE,
        offset: (page - 1) * PAGE_SIZE,
    });
    const list = (res.data || []).map((user) => ({
        id: user.id,
        name: user.name || "",
        avatar:
            pickImage(user.profile_picture) || "",
        fans: user.follower_count ?? undefined,
        description: user.bio || undefined,
    }));
    return {
        isEnd: list.length < PAGE_SIZE,
        data: list,
    };
}

module.exports = {
    platform: "Audius",
    version: "0.1.0",
    author: "Leo Hu",
    cacheControl: "cache",
    primaryKey: ["id"],
    supportedSearchType: ["music", "album", "artist"],

    async search(query, page, type) {
        if (type === "album") {
            return await searchPlaylist(query, page);
        }
        if (type === "artist") {
            return await searchArtist(query, page);
        }
        return await searchMusic(query, page);
    },

    async getMediaSource(musicItem) {
        // /stream redirects to a CDN; the app follows it and plays the mp3.
        // Return the endpoint directly so the redirect stays on the server side.
        return {
            url: `${API_BASE}/tracks/${musicItem.id}/stream?app_name=${APP_NAME}`,
        };
    },

    async getTopLists() {
        return [
            {
                title: "Trending",
                data: [
                    { id: "trending", title: "Trending Now" },
                    { id: "underground_trending", title: "Underground Trending" },
                ],
            },
        ];
    },

    async getTopListDetail(topListItem, page) {
        const path =
            topListItem.id === "underground_trending"
                ? "/tracks/trending/underground"
                : "/tracks/trending";
        const res = await apiGet(path, {
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
        });
        const list = (res.data || [])
            .map(toPlayableMusic)
            .filter((it) => it !== null);
        return {
            isEnd: list.length < PAGE_SIZE,
            musicList: list,
        };
    },

    async getMusicSheetInfo(sheetItem, page) {
        // Playlist detail may already carry its tracks; otherwise fetch them.
        if (Array.isArray(sheetItem.musicList) && sheetItem.musicList.length) {
            return {
                isEnd: true,
                musicList: sheetItem.musicList,
            };
        }
        const list = await fetchPlaylistTracks(sheetItem.id);
        return {
            isEnd: true,
            musicList: list,
        };
    },

    async getArtistWorks(artistItem, page, type) {
        if (type === "album") {
            // Audius playlists owned by the user act as albums.
            const res = await apiGet(`/users/${artistItem.id}/playlists`, {
                limit: PAGE_SIZE,
                offset: (page - 1) * PAGE_SIZE,
            });
            const list = (res.data || []).map(toSheetItem);
            return {
                isEnd: list.length < PAGE_SIZE,
                data: list,
            };
        }
        const res = await apiGet(`/users/${artistItem.id}/tracks`, {
            limit: PAGE_SIZE,
            offset: (page - 1) * PAGE_SIZE,
        });
        const list = (res.data || [])
            .map(toPlayableMusic)
            .filter((it) => it !== null);
        return {
            isEnd: list.length < PAGE_SIZE,
            data: list,
        };
    },

    // Audius has no lyrics endpoint (verified: /tracks/{id}/lyrics -> 404).
    // Returning undefined lets the app fall back gracefully.
    async getLyric() {
        return undefined;
    },

    async importMusicSheet(urlLike) {
        // Accept both https://audius.co/<user>/playlist/<slug-or-id> and a raw id.
        const match = urlLike.match(/audius\.co\/[^/]+\/playlist\/([^/?#]+)/);
        const playlistId = match ? match[1] : urlLike.trim();
        if (!playlistId) {
            return [];
        }
        return await fetchPlaylistTracks(playlistId);
    },

    async importMusicItem(urlLike) {
        const match = urlLike.match(/audius\.co\/([^/]+)\/([^/?#]+)/);
        if (match) {
            const res = await apiGet(`/tracks/${match[2]}`);
            const track = res.data;
            if (!track) {
                return undefined;
            }
            return toPlayableMusic(track);
        }
        return undefined;
    },
};
