# Hosting the dashboard on NREC (UiO/UiB cloud) or any Linux server

The folder `deploy/` is NOT part of the website (the website is only `docs/`), so GitHub Pages is not
affected by it. Use it when you have an NREC project and a web address.

How it works: a small Linux VM runs nginx and serves the `docs/` folder. The VM checks GitHub every 5 minutes
and pulls the newest version. So your workflow does not change: build on your computer, commit, push.
The VM only ever sees what is in the public repository, never your raw data.

| File | What it is |
|---|---|
| `setup_vm.sh` | one-time setup of a fresh Ubuntu/Debian VM (nginx, git, certbot, update timer) |
| `update_site.sh` | the updater (installed as `/usr/local/bin/kysthjelperne-update`); refuses to publish if raw/ or private/ files ever end up in the repo |
| `nginx-site.conf.template` | the web server settings (filled in by `setup_vm.sh`) |

## Checklist

1. **NREC project.** Sign in with Feide at https://access.nrec.no (new users). The demo project is fine for testing;
   for lasting use apply at https://request.nrec.no (see https://docs.nrec.no/project-application.html).
   Only "yellow and green" data may be stored: the published, anonymised files are fine, raw files are not.
2. **Create the VM** (https://docs.nrec.no/create-linux-machine.html): Ubuntu LTS image, a small flavor,
   your SSH key. Attach a **floating IP**.
3. **Security group** (https://docs.nrec.no/security-groups.html): allow TCP 80 and 443 from everywhere
   (0.0.0.0/0 and ::/0), and TCP 22 only from your own address / the UiO network.
4. **Domain name.** Ask UiO IT for a name such as `kysthjelperne.uio.no` that points (A record) to the floating IP.
   Without a name there is no HTTPS.
5. **Log in to the VM and run the setup:**
   ```bash
   ssh ubuntu@<floating-ip>
   sudo apt-get install -y git
   git clone https://github.com/EivindStensrud/Miljo-DNA-Kysthjelperne.git
   cd Miljo-DNA-Kysthjelperne/deploy
   sudo ./setup_vm.sh kysthjelperne.uio.no https://github.com/EivindStensrud/Miljo-DNA-Kysthjelperne.git main
   ```
   (Replace the domain and, if your repository has another name, the address. The repository must be readable
   without a password, i.e. public.)
6. **Turn on HTTPS** when the domain already points to the VM:
   ```bash
   sudo certbot --nginx -d kysthjelperne.uio.no --redirect -m eivisten@uio.no --agree-tos
   ```
   Certbot renews the certificate by itself.
7. **Test:** open https://kysthjelperne.uio.no, hard-reload (Ctrl+Shift+R).

## Daily use

* Update the site: commit and push as now. The VM has it within 5 minutes.
  Immediately: `sudo -u kystsite /usr/local/bin/kysthjelperne-update`
* See what the updater did: `journalctl -t kysthjelperne-update -n 20`
* If the updater says "REFUSING to update ... raw/ or private/": a raw data file was committed by mistake.
  Remove it from the repository (and tell the data protection officer if it contained personal data).
* Roll back: on the VM  `cd /srv/kysthjelperne/repo && sudo -u kystsite git reset --hard <commit>` and stop the
  timer (`sudo systemctl stop kysthjelperne-update.timer`) until the repository is fixed.

## Maintenance (this is what GitHub Pages did for you)

* Security updates are switched on by the setup (`unattended-upgrades`). Reboot the VM now and then
  (`sudo reboot`; the updater and nginx start again by themselves).
* Take a snapshot of the VM in the NREC dashboard after setup. The site itself is rebuilt from GitHub, so there
  is nothing else to back up.
* Write down who is responsible for the VM and the NREC project when people leave (the project is tied to people).

## Good to know

* The page loads Tailwind, Leaflet, Chart.js and PapaParse from public CDNs, so visitors' browsers contact
  those servers. For a UiO-hosted site you may want these files copied into `docs/` instead; ask and it can be done.
* Other Linux (AlmaLinux/Rocky): `setup_vm.sh` uses apt; install nginx, git and certbot with dnf, copy the nginx
  file to `/etc/nginx/conf.d/kysthjelperne.conf` (replace @DOMAIN@ and @ROOT@) and follow the same steps.
* Keep GitHub Pages running in parallel until the new address works; then change links and tell users.
