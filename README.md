# Film & TV Wishlist

A self-hosted wishlist for films and TV shows. It stores one shared list in a Docker volume.

## Run with Docker Compose

1. Use your existing `.env`, or copy `.env.example` to `.env` if you need one.
2. Set `TMDB_API_KEY` to your [TMDB API key](https://www.themoviedb.org/settings/api). TMDB supplies the data for both films and TV shows. You can keep `TVDB_API_KEY` in the same file. It stays out of the container.
3. Run the following from this directory.

   ```sh
   docker compose up --build -d
   ```

4. Open [localhost:8080](http://localhost:8080). Set `WISHLIST_PORT` in `.env` if you need a different host port.

The default port binding is local and the app has no sign-in. For a remote Docker host, use an SSH port forward or put the app behind an authenticated proxy you control.

## Use the wishlist

- **Add title** searches by name, numeric TMDB ID, or IMDb ID such as `tt0133093`. If a film and a TV show share a TMDB number, you can select either or both. For a title made entirely of digits, search with `title:`, for example `title:1917`.
- Saved cards show the poster, title, year, original language, and TMDB status captured when you add the title. TV shows use their first-air year and series status.
- Search results and saved cards use the original title for English, Spanish, Italian, and French productions. Other productions use the English title when TMDB has one.
- Filter the wishlist by title and original language. Use **Remove** when you’ve got the title.

The named volume `wishlist-data` contains `/data/wishlist.json`. It survives a rebuild or `docker compose down`. To back up the list after saving your first title, run `docker compose cp wishlist:/data/wishlist.json ./wishlist-backup.json`.

The runtime image uses `scratch` with a stripped static Go binary and a certificate bundle for TMDB HTTPS. The HTML, CSS, and JavaScript are embedded in the binary. There is no database server, shell, or frontend build step.

## Run from source

With Go 1.25 or later, run `go test ./...` to test the app against a simulated TMDB API. To start it without Docker, set `TMDB_API_KEY` in your shell and run `go run .`. The default address is `127.0.0.1:8080` and the default data directory is `./data`.
