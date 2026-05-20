// ─────────────────────────────────────────────────────────────────
//  RITHUM TEAM CONFIG
//  Edit this file to set your team's names, usernames and passwords
//  Then restart the server for changes to take effect
// ─────────────────────────────────────────────────────────────────

module.exports = {

  // TEAM MEMBERS
  // username: the login name each person types
  // name: their display name in the app
  // role: 'manager' (sees all reps) or 'rep' (sees own accounts only)
  // password: their login password

  team: {
    manager: { name: 'Philip Hall',    role: 'Manager', password: 'rithum2025' },
    rep1:    { name: 'Owen Jones',      role: 'Strategic Account Director',     password: 'rithum2025' },
    rep2:    { name: 'Julia Stolyarova',      role: 'Strategic Account Director',     password: 'rithum2025' },
    rep3:    { name: 'Gary Seneviratne',      role: 'Strategic Account Director',     password: 'rithum2025' },
    rep4:    { name: 'Seb Bauer',      role: 'Strategic Account Director',     password: 'rithum2025' },
    rep5:    { name: 'Rich Barber',      role: 'Strategic Account Director',     password: 'rithum2025' },
  },

  // EXAMPLE — replace the above with your real team:
  // team: {
  //   sarah:    { name: 'Sarah Johnson',  role: 'manager', password: 'YourPassword1' },
  //   james:    { name: 'James Murphy',   role: 'rep',     password: 'YourPassword2' },
  //   priya:    { name: 'Priya Sharma',   role: 'rep',     password: 'YourPassword3' },
  //   tom:      { name: 'Tom Williams',   role: 'rep',     password: 'YourPassword4' },
  //   hannah:   { name: 'Hannah Clarke',  role: 'rep',     password: 'YourPassword5' },
  //   oliver:   { name: 'Oliver Reed',    role: 'rep',     password: 'YourPassword6' },
  // },
};
