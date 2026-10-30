// Run inside an app container: docker compose exec app1 node /database/seeds/seed.js
const bcrypt = require('/app/node_modules/bcryptjs'); const { pool } = require('/app/src/db');
(async () => {
  const h = await bcrypt.hash('demo123', 12), ins = async (n, e, r, d) => (await pool.query('INSERT INTO users(name,email,password_hash,role,department,email_verified) VALUES($1,$2,$3,$4,$5,true) ON CONFLICT(email) DO UPDATE SET name=$1 RETURNING id', [n, e, h, r, d])).rows[0].id;
  await ins('Ada Admin', 'admin@edulearn.test', 'ADMIN', 'Administration');
  const T = []; for (const [i, n] of ['Dr. Meera Rao', 'Prof. Liam Ortiz', 'Sana Iqbal'].entries()) T.push(await ins(n, `teacher${i + 1}@edulearn.test`, 'TEACHER', 'Faculty'));
  const S = []; for (let i = 1; i <= 10; i++) S.push(await ins('Student ' + i, `student${i}@edulearn.test`, 'STUDENT', ['Computer Science', 'Data Science', 'Design'][i % 3]));
  const cat = (await pool.query("INSERT INTO categories(name) VALUES('Technology') ON CONFLICT(name) DO UPDATE SET name='Technology' RETURNING id")).rows[0].id;
  for (const [i, t] of ['Web Development', 'Python Programming', 'Database Management', 'UI/UX Design', 'Artificial Intelligence'].entries()) {
    const c = (await pool.query("INSERT INTO courses(title,description,category_id,level,teacher_id,status,published) VALUES($1,$2,$3,'Beginner',$4,'published',true) RETURNING id", [t, 'Hands-on course in ' + t, cat, T[i % 3]])).rows[0].id;
    for (let m = 1; m <= 2; m++) { const mid = (await pool.query('INSERT INTO modules(course_id,title,position) VALUES($1,$2,$3) RETURNING id', [c, 'Module ' + m, m])).rows[0].id;
      for (const [p, ty] of ['video', 'pdf', 'text'].entries()) await pool.query('INSERT INTO lessons(module_id,title,type,duration_sec,position) VALUES($1,$2,$3,600,$4)', [mid, `Lesson ${p + 1} (${ty})`, ty, p + 1]); }
    await pool.query("INSERT INTO assignments(course_id,title,instructions,due_at) VALUES($1,'Mini project','Submit a short write-up',now()+interval '10 days')", [c]);
    const qz = (await pool.query('INSERT INTO quizzes(course_id,title) VALUES($1,$2) RETURNING id', [c, t + ' quiz'])).rows[0].id;
    await pool.query(`INSERT INTO questions(quiz_id,type,prompt,options,answer,topic) VALUES($1,'mcq','Best way to learn?','["Practice","Skip labs"]','Practice','Method'),($1,'tf','Feedback helps.','["True","False"]','True','Method')`, [qz]);
    for (const s of S) if ((s + c) % 3) await pool.query('INSERT INTO enrollments(user_id,course_id) VALUES($1,$2) ON CONFLICT DO NOTHING', [s, c]);
  }
  console.log('Seeded. Login: admin@edulearn.test / demo123'); await pool.end();
})();
