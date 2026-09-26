const CATEGORIES = {
  movie: ['movie', 'movies', 'film', 'films', 'cam', 'ts', 'hdrip', 'webrip', 'bluray', 'brrip', 'dvdrip'],
  series: ['series', 'tv', 'episode', 'season', 's0', 'e0', 'complete', 'pack']
};

const CATEGORY_MAP = {
  limetorrents: {
    movie: 'movies',
    series: 'tv-shows'
  },
  cpasbien: {
    movie: 'films',
    series: 'series'
  },
  torrent9: {
    movie: 'films',
    series: 'series'
  },
  nyaa: {
    anime: ['anime', 'anime-english-translated']
  }
};

module.exports = { CATEGORIES, CATEGORY_MAP };
