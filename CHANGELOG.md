# Changelog

What changed in each release of ConnectLocal for Pressable. Add new notes under **Unreleased**; `npm run release`
turns that section into the new version's entry and uses it as the GitHub release notes.

## Unreleased

## 1.1.0 - 2026-11-05

- First release.
- Push a Local site's `wp-content` files, database, or both to a site on Pressable.
- Pull them back into an existing Local site, or into a brand-new Local site.
- Compare files on both sides and push or pull only the ones you pick.
- Find your live and staging sites with a Pressable API application (Client ID and Client Secret). The add-on reads each site's SSH user and domains from the API. Or connect with the SSH details from the site's SFTP | SSH Details in MyPressable.
- Log in with Local's SSH key (added once in MyPressable), or with the site's SSH password (stored encrypted).
- Leave WordPress core and `wp-config.php` alone on both sides, since Pressable manages core itself. Never replace the plugins and caching drop-ins Pressable links in; a pull brings Jetpack and Akismet down as real files.
- Flush the object cache and purge the Edge Cache after a push.
- Sites linked to Pressable show a small Pressable logo next to their name in Local's sites list. Other ConnectLocal
  add-ons show theirs in the same spot, so a site linked to several hosts shows each host's logo side by side.
  Hover a logo to see which Pressable site it is linked to.
- **Tools → Pressable** shows a green check while the open site is linked.
- Update checks: the add-on looks for new releases on GitHub when Local starts and every 12 hours, and shows an
  **Update** button in its panel when one is out. **Check for updates** at the bottom of the panel checks right away.

