<!-- 1. fuzzy search, may involve add more index and columns for songs, artists, etc. tables. -->

<!-- 2. add a setting button, to change the theme for the page -->

<!-- 3. change everything to chinese -->

4. design UI

5. add git version control

6. if table schema changes later, for example, more columns are added for song or clips, some table reference other table's id, how to address this

7. for songs that lyrics are not in sync, how to update them without messing up reference id

8. add feedback for user to report things, better in good format. Different types of requests. 1. Request new song; 2. Lyrics not in sync; 3. Others

9. how many color tags we need, 野歌 原唱 裂过 房间过不去 etc.

10. color tags can be edited in normal mode

11. implement import logic

12. add instructions

13. add batch operations

<!-- 11. make like button easier to click -->

12. one user two sessions, likes reflected in both

13. should I from time to time to back up data from database in case they are lost

14. user forgot password, username exists, username change

15. what it looks like in share and copy modes

16. how to arrange buttons in edit mode

17. comment needs more rows

<!-- 15. pitch is not working -->

# Question 1:

i have a general question, answer without making any changes, once I have deployed my project to a cloud, can I run in the server and make changes there like what i am doing here now

# Answer 1:

Yes, you can SSH into the server and run the same commands — scripts, database queries, Prisma migrations, etc.

But you generally shouldn't edit code directly on a production server.
The typical workflow is:
Make changes locally (like we're doing now)
Push to git
Deploy (pull on server, or use CI/CD)

For operational tasks on the server, it's fine to run:

node scripts/scan-songs-for-databasing.js — import songs
node scripts/update-starts.js — fix data
node scripts/purge-stale-pending-users.js — cleanup
npx prisma migrate deploy — apply migrations
Ad-hoc queries via node -e "..."
For code changes — always do locally, test, then deploy

# Question 2:

Any concerns on database if we hvae too many users

# Answer 2:

For your small group, the current setup handles everything fine. If scaling to 1000 users: raise the DB connection pool to 20 (one config change), add rate limiting on the like endpoint, and use deleteMany for batch unlike operations. Like toggles and clip creation are lightweight — PostgreSQL handles thousands per second. The main bottleneck at scale would be connection pooling, not query speed.

# Question 3:

What is the mechanism for uesrname/password change/forget

# Answer 3:

Change password (self-service): user fills in current password + new password in Settings. Backend verifies the current password via bcrypt, then hashes and saves the new one. JWT stays valid since it doesn't contain the password.

Change username (self-service): user fills in new username + current password in Settings. Backend verifies the password, checks the new username isn't taken, then updates the DB. Since the JWT embeds the username, the token is cleared and the user is redirected to log in again.

Forgot password / Forgot username (no self-service): there's no email field, so no reset flow exists. The user contacts the admin out-of-band, and the admin either looks up the username in the admin panel or directly resets the password hash in the DB.
