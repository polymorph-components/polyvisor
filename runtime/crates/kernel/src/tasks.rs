//! The task list behind `polyvisor:app/tasks`. In M1 it is in memory only,
//! one list per app id: every session of an app sees the same partition.

/// `polyvisor:app/tasks.todo-item`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TodoItem {
    pub id: String,
    pub title: String,
    pub completed: bool,
}

/// `polyvisor:app/tasks.snapshot`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Snapshot {
    pub revision: u64,
    pub items: Vec<TodoItem>,
}

#[derive(Default)]
pub struct TaskList {
    pub revision: u64,
    counter: u64,
    items: Vec<TodoItem>,
}

impl TaskList {
    /// Ids are zero-padded so their lexical order is their creation order —
    /// `snapshot` promises "stable (id) order" and callers compare ids as
    /// opaque strings.
    fn mint_id(&mut self) -> String {
        self.counter += 1;
        format!("{:08}", self.counter)
    }

    pub fn snapshot(&self) -> Snapshot {
        let mut items = self.items.clone();
        items.sort_by(|a, b| a.id.cmp(&b.id));
        Snapshot {
            revision: self.revision,
            items,
        }
    }

    pub fn add(&mut self, title: String) -> String {
        let id = self.mint_id();
        self.items.push(TodoItem {
            id: id.clone(),
            title,
            completed: false,
        });
        self.revision += 1;
        id
    }

    pub fn set_completed(&mut self, id: &str, completed: bool) -> Result<(), String> {
        self.item(id)?.completed = completed;
        self.revision += 1;
        Ok(())
    }

    pub fn set_title(&mut self, id: &str, title: String) -> Result<(), String> {
        self.item(id)?.title = title;
        self.revision += 1;
        Ok(())
    }

    pub fn remove(&mut self, id: &str) -> Result<(), String> {
        let before = self.items.len();
        self.items.retain(|i| i.id != id);
        if self.items.len() == before {
            return Err(no_such(id));
        }
        self.revision += 1;
        Ok(())
    }

    fn item(&mut self, id: &str) -> Result<&mut TodoItem, String> {
        self.items
            .iter_mut()
            .find(|i| i.id == id)
            .ok_or_else(|| no_such(id))
    }
}

fn no_such(id: &str) -> String {
    format!("no task with id {id}")
}
