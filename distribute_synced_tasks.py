#!/usr/bin/env python3
"""
Distributes the global synced_tasks.json to per-profile files.

Copies all task IDs from the shared synced_tasks.json into a
synced_tasks_<profileId>.json for each profile. Run this on the
Render server before restarting the app after deploying the fix.

Usage:
    python3 distribute_synced_tasks.py [--data-dir /var/data] [--dry-run]
"""

import argparse
import json
import os
import sys


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--data-dir', default='/var/data', help='Path to the data directory (default: /var/data)')
    parser.add_argument('--dry-run', action='store_true', help='Print what would happen without writing files')
    args = parser.parse_args()

    data_dir = args.data_dir
    profiles_file = os.path.join(data_dir, 'profiles.json')
    synced_file   = os.path.join(data_dir, 'synced_tasks.json')

    # Load profiles
    if not os.path.exists(profiles_file):
        sys.exit(f'ERROR: profiles.json not found at {profiles_file}')

    with open(profiles_file) as f:
        profiles = json.load(f)

    if not profiles:
        sys.exit('ERROR: profiles.json is empty — nothing to do')

    # Load existing global synced task IDs
    if not os.path.exists(synced_file):
        print(f'WARNING: {synced_file} does not exist — per-profile files will be created empty')
        task_ids = []
    else:
        with open(synced_file) as f:
            task_ids = json.load(f)
        print(f'Loaded {len(task_ids)} task IDs from {synced_file}')

    print(f'Found {len(profiles)} profile(s):\n')

    for p in profiles:
        profile_id   = p.get('id')
        profile_name = p.get('name', profile_id)
        out_file     = os.path.join(data_dir, f'synced_tasks_{profile_id}.json')

        if os.path.exists(out_file):
            with open(out_file) as f:
                existing = json.load(f)
            merged = list(set(existing) | set(task_ids))
            status = f'EXISTS ({len(existing)} IDs) → merged to {len(merged)} IDs'
        else:
            merged = task_ids
            status = f'NEW → {len(merged)} IDs'

        print(f'  [{profile_id}] {profile_name}: {status}')
        print(f'    → {out_file}')

        if not args.dry_run:
            with open(out_file, 'w') as f:
                json.dump(merged, f)

    if args.dry_run:
        print('\nDry run — no files written. Remove --dry-run to apply.')
    else:
        print('\nDone. Per-profile synced_tasks files written.')
        print(f'You can now safely delete {synced_file} (it is no longer used).')


if __name__ == '__main__':
    main()
