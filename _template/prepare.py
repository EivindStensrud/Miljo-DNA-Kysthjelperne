"""
prepare.py - PROJECT-SPECIFIC script (optional). Runs first, with this project directory as working directory.

Use it for anything that is special for this project and does not belong in the main scripts, for example:
  * convert a student's Excel sheet to the CSV files named in project.json
  * rename columns, merge two species tables, remove a failed sequencing run
  * split one export into the files project.json expects

It must write its results to the files that project.json points at (normally in raw/).
Exit with an error (raise / sys.exit(1)) to stop the build for this project.

Environment variables set by build_all.py:
    KYST_HOME         the home directory (where the main scripts are)
    KYST_PROJECT_DIR  this project directory
    KYST_PROJECT      the project code
"""
import os
from pathlib import Path

project_dir = Path(os.environ.get("KYST_PROJECT_DIR", "."))
print(f"[prepare.py] nothing to do for {project_dir.name} (edit this script if the project needs special handling)")
