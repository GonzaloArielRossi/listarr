# Film & TV Wishlist

A self-hosted wishlist for films and TV shows.

## Run with Docker Compose

1. Use your existing `.env`, or copy `.env.example` to `.env` if you need one.
2. Set `TMDB_API_KEY` to your [TMDB API key](https://www.themoviedb.org/settings/api). If your host user and group IDs differ from `1000:1000`, set `PUID` and `PGID` in `.env` to the values reported by `id -u` and `id -g`.
3. From the checkout on the Docker host, run the following to start Listarr or to upgrade an existing installation to live reload.

   ```sh
   docker compose up --build -d
   ```

4. Open [localhost:8080](http://localhost:8080). Set `WISHLIST_PORT` in `.env` if you need a different host port.

Compose uses the existing external `proxy-network`. Listarr has no sign-in, so restrict access to the published port or use an authenticated proxy.

After setup, run `git pull` in the same checkout on the Docker host. The running container detects changes to the Go source and web assets, builds a new app binary, and restarts the app. Refresh your browser after the restart. Changes to the Dockerfile, Compose config, or the watcher setup still require `docker compose up --build -d`.

The Compose image includes Go and Air to rebuild the app from the read-only checkout mount. The default standalone Dockerfile target builds a static binary with embedded web assets in a `scratch` image.

## Use the wishlist

- Type in the search bar to filter saved titles. Press Enter or select **Search TMDB** to find a title to add by name, numeric TMDB ID, or IMDb ID such as `tt0133093`. If a film and a TV show share a TMDB number, you can select either. To find a title made entirely of digits, enter `title:1917` for example.
- Saved cards show the release year, IMDb ID, and TMDB ID beneath the poster, with country-of-origin flags on the poster. TV shows use their first-air year. Listarr fills in missing country and IMDb data for existing titles when you view their cards.
- Film cards show one release tag. **Released** means the film is available to stream in the configured country. **Released in Theaters** indicates a recorded theatrical release in any country, and **Upcoming** indicates a future release. Rental and purchase listings do not qualify as streaming. Set `TMDB_REGION` in `.env` to change the streaming country from Argentina (`AR`), then run `docker compose up -d` to apply the setting.
- Search results and saved cards use the original title for English, Spanish, Italian, and French productions. Other productions use the English title when TMDB has one.
- Use **Films** or **Shows** to filter by type alongside title and original language. Select the active button again to show both types.
- Switch between **Grid** and **List** above the results. The adjacent menu sets 4, 5, or 6 cards per row in Grid, or Compact, Medium, and Large rows in List. Listarr remembers both settings in your browser.
- Open a card for IMDb, TMDB, and available TVDB links, or to copy its title. Select **Delete title** and confirm to permanently delete it.

Compose stores the list in `./listarr-data/wishlist.json` on the host. Startup assigns the mounted directory and existing data files to `PUID:PGID`, then runs the app as that user. The data survives a rebuild or `docker compose down`. To back up your wishlist, copy `./listarr-data/wishlist.json`.

## Prowlarr

Select **Connect Prowlarr** in the navbar. Enter the base URL that the Listarr server can reach and the API key from **Settings → General** in Prowlarr. For example, use `http://prowlarr:9696` if both containers share a Docker network and Prowlarr is reachable by that service name.

Open any saved title and select **Search Prowlarr**. The search starts with the card title and you can edit the query. Select a result to open its torrent or magnet link in a new tab. Listarr keeps the connection settings in `./listarr-data/prowlarr.json` when using Compose.

## Run from source

With Go 1.25 or later, run `go test ./...` to test the app against simulated TMDB and Prowlarr APIs. To start it without Docker, set `TMDB_API_KEY` in your shell and run `go run .`. The default address is `127.0.0.1:8080` and the default data directory is `./data`.
