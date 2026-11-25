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

## Use the wishlist

- **Add title** searches by name, numeric TMDB ID, or IMDb ID such as `tt0133093`. If a film and a TV show share a TMDB number, you can select either or both. For a title made entirely of digits, search with `title:`, for example `title:1917`.
- Saved cards show the poster, title, year, original language, and TMDB status captured when you add the title. TV shows use their first-air year and series status.
- Film cards show **Released in MT** after a theatrical release and **Released** when the film is available to stream. Rental and purchase listings do not qualify. Set `TMDB_REGION` in `.env` to change the country from Argentina (`AR`), then run `docker compose up -d` to apply the setting.
- Search results and saved cards use the original title for English, Spanish, Italian, and French productions. Other productions use the English title when TMDB has one.
- Use **Films** or **Shows** to filter by type alongside title and original language. Select the active button again to show both types.
- Use **Remove** and confirm to move a title to **Trash**. Restore individual titles from Trash, or select **Empty Trash** and confirm to permanently delete all titles there.

Compose stores the list in `./listarr-data/wishlist.json` on the host. Startup assigns the mounted directory and any existing wishlist file to `PUID:PGID`, then runs the app as that user. The file survives a rebuild or `docker compose down`. To back it up, copy `./listarr-data/wishlist.json`.

The Compose image includes Go and Air to rebuild the app from the read-only checkout mount. The default standalone Dockerfile target builds a static binary with embedded web assets in a `scratch` image.

## Run from source

With Go 1.25 or later, run `go test ./...` to test the app against a simulated TMDB API. To start it without Docker, set `TMDB_API_KEY` in your shell and run `go run .`. The default address is `127.0.0.1:8080` and the default data directory is `./data`.
